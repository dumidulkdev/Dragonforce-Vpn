/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.dragonforce.vpn',
  productName: 'DragonForce VPN',
  electronVersion: '33.4.11',
  directories: { output: 'release', buildResources: 'build' },
  asar: true,
  npmRebuild: false,
  files: [
    'dist-electron/desktop.cjs',
    'dist-electron/controller.cjs',
    'public/**/*',
    'package.json',
    '!**/*.map',
  ],
  extraResources: [{
    from: 'resources/native/${arch}',
    to: 'bin',
    filter: ['*.exe', '*.dll', '*.dat', 'LICENSE-*.txt', 'manifest.json'],
  }],
  win: {
    target: [
      { target: 'nsis', arch: ['x64', 'arm64', 'ia32'] },
      { target: 'portable', arch: ['x64', 'arm64', 'ia32'] },
    ],
    icon: 'build/icon.ico',
    executableName: 'DragonForce-VPN',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    artifactName: 'DragonForce-VPN-${version}-Setup.exe',
    include: 'build/installer.nsh',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false,
  },
  portable: {
    artifactName: 'DragonForce-VPN-${version}-${arch}-Portable.exe',
    requestExecutionLevel: 'user',
    buildUniversalInstaller: false,
    unpackDirName: true,
  },
  publish: null,
};
