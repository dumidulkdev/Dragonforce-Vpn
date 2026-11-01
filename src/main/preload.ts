import { contextBridge, ipcRenderer } from 'electron';
import type { LogEntry, PersistedData, RoutingMode, VpnStatus } from './types.ts';

export const vpnApi = {
  getInitialData: () => ipcRenderer.invoke('vpn:get-initial-data'),
  connect: (serverId?: string) => ipcRenderer.invoke('vpn:connect', serverId),
  disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  setRoutingMode: (mode: RoutingMode) => ipcRenderer.invoke('vpn:set-routing-mode', mode),
  toggleTerminalEnv: (enabled: boolean) => ipcRenderer.invoke('vpn:toggle-terminal-env', enabled),
  relaunchAsAdmin: () => ipcRenderer.invoke('vpn:relaunch-admin'),
  importLinks: (rawText: string) => ipcRenderer.invoke('vpn:import-links', rawText),
  selectServer: (serverId: string) => ipcRenderer.invoke('vpn:select-server', serverId),
  deleteServer: (serverId: string) => ipcRenderer.invoke('vpn:delete-server', serverId),
  pingServer: (serverId: string) => ipcRenderer.invoke('vpn:ping-server', serverId),
  pingAllServers: () => ipcRenderer.invoke('vpn:ping-all-servers'),
  testActiveTunnel: () => ipcRenderer.invoke('vpn:test-active-tunnel'),
  addSubscription: (url: string, name?: string) =>
    ipcRenderer.invoke('vpn:add-subscription', url, name),
  refreshSubscription: (subId: string) => ipcRenderer.invoke('vpn:refresh-subscription', subId),
  deleteSubscription: (subId: string) => ipcRenderer.invoke('vpn:delete-subscription', subId),
  getServerConfigJson: (serverId: string) => ipcRenderer.invoke('vpn:get-server-config', serverId),
  updateSettings: (settings: {
    socksPort?: number;
    httpPort?: number;
    bypassLan?: boolean;
    allowInsecureDefault?: boolean;
  }) => ipcRenderer.invoke('vpn:update-settings', settings),
  clearLogs: () => ipcRenderer.invoke('vpn:clear-logs'),
  onStatusUpdate: (cb: (status: VpnStatus) => void) => {
    const handler = (_e: unknown, status: VpnStatus) => cb(status);
    ipcRenderer.on('vpn:status', handler);
    return () => ipcRenderer.removeListener('vpn:status', handler);
  },
  onDataUpdate: (cb: (data: PersistedData) => void) => {
    const handler = (_e: unknown, data: PersistedData) => cb(data);
    ipcRenderer.on('vpn:data', handler);
    return () => ipcRenderer.removeListener('vpn:data', handler);
  },
  onLog: (cb: (entry: LogEntry) => void) => {
    const handler = (_e: unknown, entry: LogEntry) => cb(entry);
    ipcRenderer.on('vpn:log', handler);
    return () => ipcRenderer.removeListener('vpn:log', handler);
  },
};

contextBridge.exposeInMainWorld('vpnApi', vpnApi);
