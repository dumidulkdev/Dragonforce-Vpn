import React, { useEffect, useState } from 'react';
import {
  Power,
  Shield,
  ShieldCheck,
  Terminal,
  Server,
  Rss,
  Activity,
  ArrowDown,
  ArrowUp,
  Zap,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  Code,
  ClipboardPaste,
  Settings,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type {
  LogEntry,
  PersistedData,
  RoutingMode,
  ServerNode,
  VpnStatus,
} from '../main/types';

interface TerminalCommands {
  powershell: string;
  cmd: string;
  git: string;
  npm: string;
}

declare global {
  interface Window {
    vpnApi: {
      getInitialData: () => Promise<{
        status: VpnStatus;
        data: PersistedData;
        logs: LogEntry[];
        terminalCommands: TerminalCommands;
      }>;
      connect: (serverId?: string) => Promise<{ ok: boolean; error?: string }>;
      disconnect: () => Promise<{ ok: boolean }>;
      setRoutingMode: (mode: RoutingMode) => Promise<{ ok: boolean; error?: string }>;
      toggleTerminalEnv: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      relaunchAsAdmin: () => Promise<{ ok: boolean; error?: string }>;
      importLinks: (rawText: string) => Promise<{ importedCount: number; errors: string[] }>;
      selectServer: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
      deleteServer: (serverId: string) => Promise<{ ok: boolean }>;
      pingServer: (serverId: string) => Promise<{ ping?: number | null; error?: string }>;
      pingAllServers: () => Promise<{ ok: boolean }>;
      testActiveTunnel: () => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
      addSubscription: (
        url: string,
        name?: string
      ) => Promise<{ ok: boolean; count?: number; error?: string }>;
      refreshSubscription: (
        subId: string
      ) => Promise<{ ok: boolean; count?: number; error?: string }>;
      deleteSubscription: (subId: string) => Promise<{ ok: boolean }>;
      getServerConfigJson: (serverId: string) => Promise<string>;
      updateSettings: (settings: {
        socksPort?: number;
        httpPort?: number;
        bypassLan?: boolean;
        allowInsecureDefault?: boolean;
      }) => Promise<{ ok: boolean; terminalCommands: TerminalCommands }>;
      clearLogs: () => Promise<{ ok: boolean }>;
      onStatusUpdate: (cb: (status: VpnStatus) => void) => () => void;
      onDataUpdate: (cb: (data: PersistedData) => void) => () => void;
      onLog: (cb: (entry: LogEntry) => void) => () => void;
    };
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDuration(connectedAt: number | null): string {
  if (!connectedAt) return '00:00:00';
  const totalSec = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

export default function App() {
  const [status, setStatus] = useState<VpnStatus | null>(null);
  const [data, setData] = useState<PersistedData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [terminalCommands, setTerminalCommands] = useState<TerminalCommands | null>(null);

  const [activeTab, setActiveTab] = useState<'servers' | 'subscriptions' | 'terminal' | 'logs'>(
    'servers'
  );
  const [linkInput, setLinkInput] = useState('');
  const [subUrlInput, setSubUrlInput] = useState('');
  const [subNameInput, setSubNameInput] = useState('');
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [configModalJson, setConfigModalJson] = useState<{
    name: string;
    json: string;
  } | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'xray' | 'tun' | 'system'>('all');
  const [uptimeStr, setUptimeStr] = useState('00:00:00');
  const [tunnelTestResult, setTunnelTestResult] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    window.vpnApi.getInitialData().then((init) => {
      setStatus(init.status);
      setData(init.data);
      setLogs(init.logs);
      setTerminalCommands(init.terminalCommands);
    });

    const unsubStatus = window.vpnApi.onStatusUpdate((newStatus) => {
      setStatus({ ...newStatus });
    });
    const unsubData = window.vpnApi.onDataUpdate((newData) => {
      setData({ ...newData });
    });
    const unsubLog = window.vpnApi.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-399), entry]);
    });

    return () => {
      unsubStatus();
      unsubData();
      unsubLog();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setUptimeStr(formatDuration(status?.connectedAt ?? null));
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.connectedAt]);

  if (!status || !data) {
    return (
      <div style={{ padding: 40, color: '#9ca3af' }}>Loading Xray VPN Core Interface...</div>
    );
  }

  const activeServer: ServerNode | undefined = data.servers.find(
    (s) => s.id === status.activeServerId
  );
  const isLinux = status.platform === 'linux';

  const handleToggleConnect = async () => {
    setTunnelTestResult(null);
    if (status.connected || status.connecting) {
      await window.vpnApi.disconnect();
    } else {
      const res = await window.vpnApi.connect();
      if (!res.ok && res.error) {
        showToast(res.error);
      }
    }
  };

  const handleImportLinks = async (raw?: string) => {
    const textToImport = (raw ?? linkInput).trim();
    if (!textToImport) return;
    const res = await window.vpnApi.importLinks(textToImport);
    if (res.importedCount > 0) {
      setLinkInput('');
      showToast(`Imported ${res.importedCount} server node(s)`);
    } else {
      showToast(res.errors[0] || 'No valid vless:// or vmess:// links found');
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        showToast('Clipboard is empty');
        return;
      }
      await handleImportLinks(text);
    } catch {
      showToast('Failed to read clipboard');
    }
  };

  const handlePingAll = async () => {
    setBusyMessage('Pinging all servers...');
    try {
      await window.vpnApi.pingAllServers();
    } catch {
      showToast('Could not measure server latency. Try again.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleTestTunnel = async () => {
    setTunnelTestResult('Testing...');
    const res = await window.vpnApi.testActiveTunnel();
    if (res.ok) {
      setTunnelTestResult(`Verified: ${res.latencyMs} ms`);
    } else {
      setTunnelTestResult(`Failed: ${res.error || 'Timeout'}`);
    }
  };

  const handleAddSubscription = async () => {
    if (!subUrlInput.trim()) return;
    setBusyMessage('Fetching subscription...');
    const res = await window.vpnApi.addSubscription(subUrlInput.trim(), subNameInput.trim());
    setBusyMessage(null);
    if (res.ok) {
      setSubUrlInput('');
      setSubNameInput('');
      showToast(`Added subscription (${res.count} servers)`);
    } else {
      showToast(res.error || 'Subscription failed');
    }
  };

  const handleInspectConfig = async (node: ServerNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const json = await window.vpnApi.getServerConfigJson(node.id);
    setConfigModalJson({ name: node.name, json });
  };

  const filteredLogs = logs.filter((l) => logFilter === 'all' || l.source === logFilter);

  return (
    <div className="app-layout">
      {/* LEFT PANEL */}
      <aside className="left-panel">
        <div className="brand-header">
          <div className="brand-title">
            <Shield size={22} color="#3b82f6" />
            <span>Xray VPN</span>
          </div>
          <span className={`brand-badge ${status.isAdmin ? 'admin' : ''}`}>
            {status.isAdmin ? 'Admin • TUN Ready' : 'Standard User'}
          </span>
        </div>

        {/* POWER CARD */}
        <div className={`power-card ${status.connected ? 'connected' : ''}`}>
          <button
            className={`power-btn ${
              status.connected ? 'connected' : status.connecting ? 'connecting' : ''
            }`}
            onClick={handleToggleConnect}
            title={status.connected ? 'Click to Disconnect' : 'Click to Connect'}
          >
            <Power size={36} />
            <span style={{ fontSize: '0.72rem', fontWeight: 700 }}>
              {status.connected ? 'ONLINE' : status.connecting ? 'WAIT...' : 'CONNECT'}
            </span>
          </button>

          <div className="status-text">
            {status.connected
              ? `Connected (${uptimeStr})`
              : status.connecting
                ? 'Starting Xray Core...'
                : 'Disconnected'}
          </div>

          <div className="status-sub">
            {activeServer
              ? `${activeServer.name} (${activeServer.protocol.toUpperCase()} • ${activeServer.security.toUpperCase()})`
              : 'No server selected'}
          </div>

          {status.connected && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
              <button className="btn success" onClick={handleTestTunnel}>
                <Zap size={13} />
                {tunnelTestResult || 'Verify TLS Tunnel'}
              </button>
            </div>
          )}
        </div>

        {/* ROUTING MODE SELECTOR */}
        <div>
          <div
            style={{
              fontSize: '0.74rem',
              color: '#9ca3af',
              marginBottom: 6,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>TRAFFIC ROUTING MODE</span>
            <span>
              {status.tunActive
                ? isLinux ? 'Linux IPv4 TUN' : 'Wintun L3 Adapter'
                : `HTTP :${status.httpPort}`}
            </span>
          </div>
          <div className="mode-selector">
            <button
              className={`mode-btn ${status.routingMode === 'system_proxy' ? 'active' : ''}`}
              onClick={() => window.vpnApi.setRoutingMode('system_proxy')}
            >
              <ShieldCheck size={15} />
              {isLinux ? 'Local Proxy' : 'System Proxy'}
            </button>
            <button
              className={`mode-btn tun ${status.routingMode === 'tun' ? 'active' : ''}`}
              onClick={() => window.vpnApi.setRoutingMode('tun')}
              disabled={isLinux && !status.tunCapability.available}
              title={isLinux && !status.tunCapability.available ? status.tunCapability.reason || '' : ''}
            >
              <Terminal size={15} />
              {isLinux ? 'Linux TUN' : 'Full TUN Mode'}
            </button>
          </div>
        </div>

        {/* ADMIN / TERMINAL HELPER BANNER */}
        {status.routingMode === 'tun' && !isLinux && !status.isAdmin && (
          <div className="alert-banner">
            <div>
              <strong>TUN Mode needs Admin</strong>
              <div style={{ fontSize: '0.73rem', opacity: 0.9 }}>
                Required to create the Wintun virtual adapter & routes.
              </div>
            </div>
            <button
              className="btn warn"
              onClick={() => window.vpnApi.relaunchAsAdmin()}
              title="Relaunch app with Windows Administrator privileges"
            >
              Elevate
            </button>
          </div>
        )}
        {isLinux && (
          <div className={`alert-banner ${status.tunCapability.available ? 'success' : ''}`}>
            <div>
              <strong>Linux network helper</strong>
              <div style={{ fontSize: '0.73rem', opacity: 0.9 }}>
                {status.tunCapability.available
                  ? 'Installed. Polkit authorization is requested when Linux TUN connects.'
                  : status.tunCapability.reason}
              </div>
            </div>
          </div>
        )}

        {/* 1-CLICK TERMINAL ENV PROXY TOGGLE */}
        <div
          className="stat-card"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, display: 'flex', gap: 6 }}>
              <Terminal size={15} color="#60a5fa" />
              <span>Terminal Proxy Env</span>
            </div>
            <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
              Sets HTTP_PROXY / ALL_PROXY for npm, git, curl, pip
            </div>
          </div>
          <button
            className={`btn ${status.terminalEnvActive ? 'success' : ''}`}
            onClick={() => window.vpnApi.toggleTerminalEnv(!status.terminalEnvActive)}
          >
            {status.terminalEnvActive ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* REAL-TIME SPEED & USAGE TELEMETRY */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">
              <ArrowDown size={14} color="#10b981" />
              <span>DOWNLOAD</span>
            </div>
            <div className="stat-speed" style={{ color: '#34d399' }}>
              {formatBytes(status.stats.downSpeed)}/s
            </div>
            <div className="stat-total">Session: {formatBytes(status.stats.sessionDown)}</div>
            <div className="stat-total">Total: {formatBytes(status.stats.totalDown)}</div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              <ArrowUp size={14} color="#3b82f6" />
              <span>UPLOAD</span>
            </div>
            <div className="stat-speed" style={{ color: '#60a5fa' }}>
              {formatBytes(status.stats.upSpeed)}/s
            </div>
            <div className="stat-total">Session: {formatBytes(status.stats.sessionUp)}</div>
            <div className="stat-total">Total: {formatBytes(status.stats.totalUp)}</div>
          </div>
        </div>

        {status.lastError && (
          <div className="alert-banner">
            <AlertTriangle size={16} />
            <span style={{ flex: 1 }}>{status.lastError}</span>
          </div>
        )}
      </aside>

      {/* RIGHT PANEL */}
      <main className="right-panel">
        <header className="nav-tabs">
          <div className="tab-group">
            <button
              className={`tab-btn ${activeTab === 'servers' ? 'active' : ''}`}
              onClick={() => setActiveTab('servers')}
            >
              <Server size={16} />
              Servers ({data.servers.length})
            </button>
            <button
              className={`tab-btn ${activeTab === 'subscriptions' ? 'active' : ''}`}
              onClick={() => setActiveTab('subscriptions')}
            >
              <Rss size={16} />
              Subscriptions ({data.subscriptions.length})
            </button>
            <button
              className={`tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setActiveTab('terminal')}
            >
              <Settings size={16} />
              Terminal & Settings
            </button>
            <button
              className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <Activity size={16} />
              Core Logs ({logs.length})
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {busyMessage && (
              <span style={{ fontSize: '0.78rem', color: '#60a5fa' }}>{busyMessage}</span>
            )}
            {toast && (
              <span
                style={{
                  fontSize: '0.78rem',
                  background: 'rgba(16, 185, 129, 0.18)',
                  color: '#34d399',
                  padding: '5px 10px',
                  borderRadius: 6,
                }}
              >
                {toast}
              </span>
            )}
          </div>
        </header>

        {/* TAB 1: SERVERS */}
        {activeTab === 'servers' && (
          <div className="tab-content">
            <div className="import-box">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                  Add VLESS / VMess Share Link (Supports TLS, Reality, TCP, WS, gRPC)
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={handlePasteClipboard}>
                    <ClipboardPaste size={14} />
                    Paste from Clipboard
                  </button>
                  <button className="btn" onClick={handlePingAll}>
                    <Zap size={14} />
                    Ping All
                  </button>
                </div>
              </div>
              <div className="input-row">
                <input
                  className="text-input"
                  placeholder="Paste vless://... or vmess://... link (or Base64 list)"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleImportLinks()}
                />
                <button className="btn primary" onClick={() => handleImportLinks()}>
                  <Plus size={15} />
                  Import Link
                </button>
              </div>
            </div>

            {data.servers.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '60px 20px',
                  color: '#9ca3af',
                  border: '1px dashed #1f2937',
                  borderRadius: 12,
                }}
              >
                <Server size={36} style={{ marginBottom: 10, opacity: 0.5 }} />
                <div style={{ fontWeight: 600, color: '#e5e7eb', marginBottom: 4 }}>
                  No VLESS or VMess servers added yet
                </div>
                <div style={{ fontSize: '0.82rem' }}>
                  Paste a <code>vless://</code> or <code>vmess://</code> link above, or import a
                  Subscription URL in the Subscriptions tab.
                </div>
              </div>
            ) : (
              <div className="server-list">
                {data.servers.map((node) => {
                  const isSelected = status.activeServerId === node.id;
                  const isConnectedNode = status.connected && isSelected;
                  return (
                    <div
                      key={node.id}
                      className={`server-card ${
                        isConnectedNode
                          ? 'active-connected'
                          : isSelected
                            ? 'selected'
                            : ''
                      }`}
                      onClick={() => window.vpnApi.selectServer(node.id)}
                    >
                      <div className="server-info">
                        <div className="server-name-row">
                          {isConnectedNode && <CheckCircle2 size={16} color="#10b981" />}
                          <span className="server-name">{node.name}</span>
                          <span className="server-host">
                            {node.address}:{node.port}
                          </span>
                        </div>

                        <div className="badge-row">
                          <span className={`tag ${node.protocol}`}>{node.protocol}</span>
                          <span className="tag net">{node.network.toUpperCase()}</span>
                          {node.security !== 'none' && (
                            <span className={`tag ${node.security}`}>
                              {node.security.toUpperCase()}
                            </span>
                          )}
                          {node.sni && <span className="tag net">SNI: {node.sni}</span>}
                          {node.host && <span className="tag net">Host: {node.host}</span>}
                          {node.path && <span className="tag net">Path: {node.path}</span>}
                        </div>
                      </div>

                      <div className="server-actions" onClick={(e) => e.stopPropagation()}>
                        {(node.pingStatus === 'measuring' || (node.ping !== null && node.ping !== undefined)) && (
                          <span
                            className={`ping-pill ${
                              (node.ping ?? 0) < 0
                                ? 'fail'
                                : node.ping != null && node.ping < 180
                                  ? 'fast'
                                  : 'medium'
                            }`}
                            title={node.pingError || 'Direct TCP handshake latency'}
                          >
                            {node.pingStatus === 'measuring'
                              ? 'Testing…'
                              : node.ping != null && node.ping >= 0
                                ? `${node.ping} ms`
                                : node.pingStatus === 'timeout' ? 'Timeout'
                                : node.pingStatus === 'dns-error' ? 'DNS failed'
                                : node.pingStatus === 'refused' ? 'Refused'
                                : node.pingStatus === 'unreachable' ? 'No route' : 'Failed'}
                          </span>
                        )}

                        <button
                          className="btn"
                          title="Measure direct TCP latency"
                          disabled={node.pingStatus === 'measuring'}
                          onClick={async () => {
                            try {
                              const res = await window.vpnApi.pingServer(node.id);
                              if (res.error) showToast(res.error);
                            } catch {
                              showToast('Could not measure server latency. Try again.');
                            }
                          }}
                        >
                          <Zap size={14} />
                        </button>

                        <button
                          className="btn"
                          title="View Generated Xray JSON Config"
                          onClick={(e) => handleInspectConfig(node, e)}
                        >
                          <Code size={14} />
                        </button>

                        <button
                          className="btn"
                          title="Copy Raw Share Link"
                          onClick={() => {
                            navigator.clipboard.writeText(node.rawUri);
                            showToast('Copied link to clipboard');
                          }}
                        >
                          <Copy size={14} />
                        </button>

                        <button
                          className="btn danger"
                          title="Delete Server"
                          onClick={() => window.vpnApi.deleteServer(node.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: SUBSCRIPTIONS */}
        {activeTab === 'subscriptions' && (
          <div className="tab-content">
            <div className="import-box">
              <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                Add Subscription URL (Auto-imports all VLESS/VMess nodes & reads bandwidth quota)
              </span>
              <div className="input-row">
                <input
                  className="text-input"
                  style={{ maxWidth: 200 }}
                  placeholder="Optional label (e.g. Main VPN)"
                  value={subNameInput}
                  onChange={(e) => setSubNameInput(e.target.value)}
                />
                <input
                  className="text-input"
                  placeholder="https://example.com/sub/..."
                  value={subUrlInput}
                  onChange={(e) => setSubUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddSubscription()}
                />
                <button className="btn primary" onClick={handleAddSubscription}>
                  <Plus size={15} />
                  Add Subscription
                </button>
              </div>
            </div>

            {data.subscriptions.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '60px 20px',
                  color: '#9ca3af',
                  border: '1px dashed #1f2937',
                  borderRadius: 12,
                }}
              >
                <Rss size={36} style={{ marginBottom: 10, opacity: 0.5 }} />
                <div style={{ fontWeight: 600, color: '#e5e7eb', marginBottom: 4 }}>
                  No Subscriptions Added
                </div>
                <div style={{ fontSize: '0.82rem' }}>
                  Enter a Subscription URL above to automatically fetch and sync multiple VLESS /
                  VMess servers.
                </div>
              </div>
            ) : (
              <div className="server-list">
                {data.subscriptions.map((sub) => {
                  const usedBytes = (sub.uploadBytes || 0) + (sub.downloadBytes || 0);
                  const totalBytes = sub.totalBytes || 0;
                  const pct =
                    totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;

                  return (
                    <div
                      key={sub.id}
                      className="server-card"
                      style={{ cursor: 'default', alignItems: 'flex-start' }}
                    >
                      <div className="server-info" style={{ flex: 1, marginRight: 16 }}>
                        <div className="server-name-row">
                          <span className="server-name">{sub.name}</span>
                          <span className="tag vless">{sub.nodeCount} servers</span>
                        </div>
                        <div className="server-host">{sub.url}</div>
                        <div style={{ fontSize: '0.73rem', color: '#9ca3af' }}>
                          Last synced: {new Date(sub.updatedAt).toLocaleString()}
                          {sub.expireTimestamp
                            ? ` • Expires: ${new Date(sub.expireTimestamp).toLocaleDateString()}`
                            : ''}
                        </div>

                        {totalBytes > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: '0.74rem',
                              }}
                            >
                              <span>
                                Subscription Usage: {formatBytes(usedBytes)} /{' '}
                                {formatBytes(totalBytes)}
                              </span>
                              <span>{pct}%</span>
                            </div>
                            <div className="quota-bar-bg">
                              <div className="quota-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="server-actions">
                        <button
                          className="btn"
                          onClick={async () => {
                            setBusyMessage(`Refreshing ${sub.name}...`);
                            const res = await window.vpnApi.refreshSubscription(sub.id);
                            setBusyMessage(null);
                            showToast(
                              res.ok
                                ? `Updated (${res.count} servers)`
                                : res.error || 'Refresh failed'
                            );
                          }}
                        >
                          <RefreshCw size={14} />
                          Sync
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => window.vpnApi.deleteSubscription(sub.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: TERMINAL & ROUTING SETTINGS */}
        {activeTab === 'terminal' && (
          <div className="tab-content">
            <div className="info-banner">
              <strong>How Terminal Install Commands (npm, pip, git, curl, winget) Work:</strong>
              <ul style={{ marginLeft: 18, marginTop: 6 }}>
                <li>
                  <strong>Option 1 — Full TUN Mode (Recommended):</strong> Creates the{' '}
                  <code>XrayTUN</code> virtual network adapter (<code>198.18.0.1</code>) using{' '}
                  <code>tun2socks + wintun.dll</code>. Routes 100% of terminal commands and apps
                  automatically at Layer 3 (requires running as Administrator).
                </li>
                <li>
                  <strong>Option 2 — Terminal Proxy Env Toggle:</strong> Enables{' '}
                  <code>HTTP_PROXY</code>, <code>HTTPS_PROXY</code>, and <code>ALL_PROXY</code> in
                  Windows User Environment Variables without needing Administrator privileges!
                </li>
              </ul>
            </div>

            {terminalCommands && (
              <div className="import-box">
                <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>
                  Quick Copy Terminal Proxy Commands (For Already-Open Terminal Windows)
                </span>

                {(
                  [
                    ['PowerShell (Current Session)', terminalCommands.powershell],
                    ['Command Prompt (CMD)', terminalCommands.cmd],
                    ['Git Global Proxy', terminalCommands.git],
                    ['NPM Global Proxy', terminalCommands.npm],
                  ] as const
                ).map(([label, cmd]) => (
                  <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: '0.74rem', color: '#9ca3af' }}>{label}</span>
                    <div className="input-row">
                      <input className="text-input" readOnly value={cmd} />
                      <button
                        className="btn"
                        onClick={() => {
                          navigator.clipboard.writeText(cmd);
                          showToast(`Copied ${label} command`);
                        }}
                      >
                        <Copy size={14} />
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="import-box">
              <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>
                Xray Local Inbound & TLS Options
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                    Local SOCKS5 Inbound Port
                  </label>
                  <input
                    className="text-input"
                    style={{ width: '100%', marginTop: 4 }}
                    type="number"
                    value={data.socksPort}
                    onChange={async (e) => {
                      const val = Number(e.target.value);
                      if (val > 1024 && val < 65535) {
                        const res = await window.vpnApi.updateSettings({ socksPort: val });
                        setTerminalCommands(res.terminalCommands);
                      }
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                    Local HTTP Inbound Port
                  </label>
                  <input
                    className="text-input"
                    style={{ width: '100%', marginTop: 4 }}
                    type="number"
                    value={data.httpPort}
                    onChange={async (e) => {
                      const val = Number(e.target.value);
                      if (val > 1024 && val < 65535) {
                        const res = await window.vpnApi.updateSettings({ httpPort: val });
                        setTerminalCommands(res.terminalCommands);
                      }
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem' }}>
                  <input
                    type="checkbox"
                    checked={data.bypassLan}
                    onChange={(e) =>
                      window.vpnApi.updateSettings({ bypassLan: e.target.checked })
                    }
                  />
                  Bypass LAN & Private Subnets (192.168.x.x / 10.x.x.x)
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem' }}>
                  <input
                    type="checkbox"
                    checked={data.allowInsecureDefault}
                    onChange={(e) =>
                      window.vpnApi.updateSettings({
                        allowInsecureDefault: e.target.checked,
                      })
                    }
                  />
                  Allow Insecure TLS Certificates (Self-Signed Server Certs)
                </label>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: LIVE LOGS */}
        {activeTab === 'logs' && (
          <div className="tab-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['all', 'xray', 'tun', 'system'] as const).map((src) => (
                  <button
                    key={src}
                    className={`btn ${logFilter === src ? 'primary' : ''}`}
                    onClick={() => setLogFilter(src)}
                  >
                    {src.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                className="btn"
                onClick={async () => {
                  await window.vpnApi.clearLogs();
                  setLogs([]);
                }}
              >
                <Trash2 size={14} />
                Clear Logs
              </button>
            </div>

            <div className="log-console">
              {filteredLogs.length === 0 ? (
                <div style={{ color: '#6b7280' }}>No log entries yet.</div>
              ) : (
                filteredLogs.map((l) => (
                  <div key={l.id} className={`log-line ${l.level}`}>
                    <span style={{ color: '#6b7280' }}>
                      [{new Date(l.timestamp).toLocaleTimeString()}]
                    </span>{' '}
                    <span style={{ fontWeight: 700 }}>[{l.source.toUpperCase()}]</span>{' '}
                    {l.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>

      {/* CONFIG JSON INSPECTION MODAL */}
      {configModalJson && (
        <div className="modal-backdrop" onClick={() => setConfigModalJson(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>Generated Xray Config — {configModalJson.name}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    navigator.clipboard.writeText(configModalJson.json);
                    showToast('Copied config.json');
                  }}
                >
                  <Copy size={14} />
                  Copy JSON
                </button>
                <button className="btn" onClick={() => setConfigModalJson(null)}>
                  Close
                </button>
              </div>
            </div>
            <div className="modal-body">{configModalJson.json}</div>
          </div>
        </div>
      )}
    </div>
  );
}
