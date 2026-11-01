import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataDir = path.resolve(argument('vpn-data-dir') || process.env.VPN_DATA_DIR || (
  app.isPackaged ? path.join(app.getPath('appData'), 'DragonForce VPN') : path.join(app.getAppPath(), 'data')
));
const port = Number(argument('vpn-ui-port') || process.env.VPN_UI_PORT || 17890);
const appUrl = `http://127.0.0.1:${port}`;
let mainWindow: BrowserWindow | null = null;
let controller: ChildProcess | null = null;
let controllerReady = false;
let shutdownRequested = false;
let exitAllowed = false;
let elevation: Promise<void> | null = null;
let controllerOutput = '';

app.setName('DragonForce VPN');
app.setAppUserModelId('com.dragonforce.vpn');

function log(message: string) {
  controllerOutput = (controllerOutput + message).slice(-12000);
  try { fs.appendFileSync(path.join(dataDir, 'desktop.log'), message); } catch { /* The error dialog still has the in-memory log. */ }
}

function showError(message: string) {
  log(`${message}\n`);
  dialog.showErrorBox('DragonForce VPN', message);
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestShutdown() {
  if (!controller || shutdownRequested) return;
  shutdownRequested = true;
  mainWindow?.setTitle('DragonForce VPN — Disconnecting…');
  controller.send({ type: 'shutdown' }, error => {
    if (error && controller?.exitCode === null) {
      shutdownRequested = false;
      showError(`Could not request VPN cleanup: ${error.message}`);
    }
  });
}

// Start-Process receives one Windows command line, rather than an argv array.
function quoteArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

async function relaunchElevated() {
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = [
    ...(app.isPackaged ? [] : [app.getAppPath()]),
    `--vpn-data-dir=${dataDir}`,
    `--vpn-ui-port=${port}`,
  ];
  const psQuote = (value: string) => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath '${psQuote(executable)}' -WorkingDirectory '${psQuote(path.dirname(executable))}' -ArgumentList '${psQuote(args.map(quoteArgument).join(' '))}' -Verb RunAs`;
  // The elevated replacement takes over the controller only after UAC succeeds.
  app.releaseSingleInstanceLock();
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { windowsHide: true });
  } catch (error) {
    app.requestSingleInstanceLock();
    throw error;
  }
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 680,
    title: 'DragonForce VPN',
    icon: path.join(app.getAppPath(), 'public/assets/logo.png'),
    backgroundColor: '#f5f6fa',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow = window;
  const external = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(error => log(`${error}\n`));
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appUrl) { event.preventDefault(); external(url); }
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window.webContents && contents.getURL().startsWith(appUrl + '/') &&
      ['clipboard-read', 'clipboard-sanitized-write', 'media'].includes(permission));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, origin) =>
    contents === window.webContents && origin === appUrl &&
    ['clipboard-read', 'clipboard-sanitized-write', 'media'].includes(permission));
  window.once('ready-to-show', () => { if (!shutdownRequested) { window.maximize(); window.show(); } });
  window.on('close', event => {
    if (!exitAllowed && controller) { event.preventDefault(); app.quit(); }
  });
  window.on('session-end', requestShutdown);
  window.on('closed', () => { mainWindow = null; });
  await window.loadURL(appUrl);
}

function startController() {
  const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(app.getAppPath(), 'resources/bin');
  const child = fork(path.join(__dirname, 'controller.cjs'), [], {
    execPath: process.execPath,
    execArgv: [],
    cwd: dataDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VPN_DESKTOP_HOST: '1',
      VPN_APP_ROOT: app.getAppPath(),
      VPN_BIN_DIR: binDir,
      VPN_DATA_DIR: dataDir,
      VPN_UI_PORT: String(port),
      NO_OPEN_WINDOW: '1',
    },
  });
  controller = child;
  child.stdout?.on('data', chunk => log(String(chunk)));
  child.stderr?.on('data', chunk => log(String(chunk)));
  child.on('message', async (message: any) => {
    if (message?.type === 'ready' && !controllerReady) {
      controllerReady = true;
      if (!shutdownRequested) {
        try { await createWindow(); }
        catch (error) { showError(`Could not open the dashboard: ${error}`); app.quit(); }
      }
    } else if (message?.type === 'shutdown-error') {
      shutdownRequested = false;
      mainWindow?.setTitle('DragonForce VPN');
      showError(`VPN cleanup could not finish. Close the window again to retry.\n\n${message.error}`);
      focusWindow();
    } else if (message?.type === 'relaunch-admin' && typeof message.id === 'string') {
      let error: string | undefined;
      try {
        elevation ??= relaunchElevated().finally(() => { elevation = null; });
        await elevation;
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      if (child.connected) child.send({ type: 'relaunch-admin-result', id: message.id, error }, () => {});
    }
  });
  child.once('error', error => {
    showError(`Could not start the VPN controller: ${error.message}`);
    if (!child.pid) { controller = null; exitAllowed = true; }
    app.quit();
  });
  child.once('exit', (code, signal) => {
    controller = null;
    if (code !== 0) showError(`The VPN controller stopped (${signal || code}).\n\n${controllerOutput.trim()}`);
    exitAllowed = true;
    app.quit();
  });
}

app.on('before-quit', event => {
  if (!exitAllowed && controller) { event.preventDefault(); requestShutdown(); }
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance', focusWindow);

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VPN_UI_PORT must be a port between 1 and 65535.');
  fs.mkdirSync(path.join(dataDir, 'browser'), { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', path.join(dataDir, 'browser'));
  if (!app.requestSingleInstanceLock()) {
    exitAllowed = true;
    app.quit();
  } else {
    void app.whenReady().then(() => {
      fs.writeFileSync(path.join(dataDir, 'desktop.log'), `DragonForce VPN ${app.getVersion()} (${process.arch})\n`);
      Menu.setApplicationMenu(null);
      startController();
    }).catch(error => { showError(String(error)); app.quit(); });
  }
} catch (error) { showError(String(error)); app.quit(); }
