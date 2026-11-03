export type ProtocolType = 'vless' | 'vmess';
export type NetworkType = 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp';
export type SecurityType = 'tls' | 'reality' | 'none';
export type RoutingMode = 'system_proxy' | 'tun';

export type ServerPingStatus = 'measuring' | 'ok' | 'timeout' | 'dns-error' | 'refused' | 'unreachable' | 'error';

export interface ServerPingResult {
  ping: number;
  pingStatus: Exclude<ServerPingStatus, 'measuring'>;
  pingError?: string;
  pingCheckedAt: number;
}

/** Geo-IP lookup result (from ip-api.com / ipwho.is). */
export interface GeoInfo {
  ip: string;
  country: string;
  countryCode: string;
  city: string;
  lat: number;
  lon: number;
}

export interface ServerNode {
  id: string;
  name: string;
  protocol: ProtocolType;
  address: string;
  port: number;
  uuid: string;
  // VMess specific
  alterId?: number;
  cipher?: string;
  // VLESS specific
  encryption?: string;
  flow?: string;
  // Transport (StreamSettings)
  network: NetworkType;
  headerType?: string;
  host?: string;
  path?: string;
  // TLS / Reality
  security: SecurityType;
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  allowInsecure?: boolean;
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
  // Metadata
  rawUri: string;
  subscriptionId?: string;
  ping?: number | null;
  pingStatus?: ServerPingStatus;
  pingError?: string;
  pingCheckedAt?: number;
  geo?: GeoInfo | null;
}

export interface SubscriptionItem {
  id: string;
  name: string;
  url: string;
  createdAt?: number;
  updatedAt: number;
  enabled: boolean;
  uploadBytes?: number;
  downloadBytes?: number;
  totalBytes?: number;
  expireTimestamp?: number;
  updateIntervalHours?: number;
  supportUrl?: string;
  nodeCount: number;
}

export interface TrafficStats {
  upSpeed: number;
  downSpeed: number;
  sessionUp: number;
  sessionDown: number;
  totalUp: number;
  totalDown: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  source: 'xray' | 'tun' | 'system';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface VpnStatus {
  connected: boolean;
  connecting: boolean;
  activeServerId: string | null;
  routingMode: RoutingMode;
  isAdmin: boolean;
  tunActive: boolean;
  systemProxyActive: boolean;
  terminalEnvActive: boolean;
  connectedAt: number | null;
  lastError: string | null;
  socksPort: number;
  httpPort: number;
  binariesReady: {
    xray: boolean;
    tun2socks: boolean;
    wintun: boolean;
  };
  stats: TrafficStats;
  /** Public exit IP + location observed through the tunnel (null when unknown). */
  exitGeo?: GeoInfo | null;
}

export type ThemePreference = 'light' | 'dark' | 'material_you';

export interface NotificationPreferences {
  connectionEvents: boolean;
  connectionLost: boolean;
  connectionFailed: boolean;
  dataCapAlerts: boolean;
  subscriptionUpdates: boolean;
  usageSummary: boolean;
  shieldMilestones: boolean;
}

export interface PersistedData {
  servers: ServerNode[];
  subscriptions: SubscriptionItem[];
  activeServerId: string | null;
  routingMode: RoutingMode;
  socksPort: number;
  httpPort: number;
  bypassLan: boolean;
  allowInsecureDefault: boolean;
  totalUp: number;
  totalDown: number;
  /** User's own location, looked up while disconnected. */
  originGeo?: GeoInfo | null;
  /** Geo-IP results keyed by server IP so subscription refreshes don't re-query. */
  geoCache?: Record<string, GeoInfo>;
  /** Multiplex connections over one tunnel connection ("Fast connect"). Default false. */
  muxEnabled?: boolean;
  /** Most recent speed test results, newest first. */
  speedTests?: SpeedTestResult[];
  /** Persistent traffic history & per-server analytics across restarts. */
  usageHistory?: UsageHistory;
  /** True once the user has completed or dismissed the first-run onboarding tour. */
  onboardingCompleted?: boolean;
  /** Persistent Brave-style Ad, Tracker & YouTube Ad Shield configuration and telemetry. */
  adblock?: AdBlockState;
  /** System-wide UI theme preference ('light' | 'dark' | 'material_you'). */
  theme?: ThemePreference;
  /** Smart Split Tunneling configuration (Bypass VPN or VPN-Only per app/site/IP). */
  splitTunnel?: SplitTunnelConfig;
  /** Android notification channel preferences. */
  notifications?: NotificationPreferences;
}

export type SplitTunnelMode = 'off' | 'bypass' | 'vpn_only';

export type SplitTunnelPresetId =
  | 'sri_lanka_local'
  | 'gaming'
  | 'streaming'
  | 'messaging'
  | 'ai_cloud'
  | 'windows_updates';

export type PerAppSplitMode = 'off' | 'bypass_selected' | 'only_selected';

export interface SplitTunnelConfig {
  mode: SplitTunnelMode;
  presets: Record<SplitTunnelPresetId, boolean>;
  customDomains: string[];
  customIps: string[];
  /** Android per-application split tunneling mode. */
  perAppMode?: PerAppSplitMode;
  /** Android package names selected for per-application split tunneling. */
  selectedApps?: string[];
}

export type AdBlockCategory = 'youtube_ads' | 'ad_networks' | 'trackers' | 'malware' | 'custom';

export interface AdBlockConfig {
  enabled: boolean;
  blockYoutubeAds: boolean;
  blockAds: boolean;
  blockTrackers: boolean;
  blockMalware: boolean;
  adguardDns: boolean;
  customBlockedDomains: string[];
  whitelistedDomains: string[];
}

export interface AdBlockDomainRecord {
  domain: string;
  category: AdBlockCategory;
  count: number;
  savedBytes: number;
  lastBlockedAt: number;
}

export interface AdBlockEvent {
  id: string;
  timestamp: number;
  domain: string;
  category: AdBlockCategory;
  savedBytes: number;
}

export interface AdBlockHourlyBucket {
  key: string;
  timestamp: number;
  blocked: number;
  savedBytes: number;
}

export interface AdBlockState {
  config: AdBlockConfig;
  totalBlocked: number;
  savedBytes: number;
  savedMs: number;
  byCategory: Record<AdBlockCategory, { blocked: number; savedBytes: number }>;
  hourly: AdBlockHourlyBucket[];
  topDomains: Record<string, AdBlockDomainRecord>;
  recentBlocked: AdBlockEvent[];
}

export interface UsageBucket {
  /** Bucket key: epoch-ms for minute/hour buckets, or 'YYYY-MM-DD' for daily buckets. */
  key: string;
  timestamp: number;
  upBytes: number;
  downBytes: number;
}

export interface ServerUsageRecord {
  serverId: string;
  serverName: string;
  address: string;
  protocol: ProtocolType;
  countryCode?: string | null;
  country?: string | null;
  subscriptionId?: string | null;
  upBytes: number;
  downBytes: number;
  connectedSeconds: number;
  sessions: number;
  lastUsedAt: number;
}

export interface DataCapConfig {
  enabled: boolean;
  /** Cap period: 'daily' or 'monthly' */
  period: 'daily' | 'monthly';
  /** Data cap in bytes (e.g. 50 * 1024^3 for 50 GB) */
  limitBytes: number;
  /** Alert threshold percentage (e.g. 80) */
  alertPct: number;
  /** Automatically disconnect VPN when 100% of cap is reached */
  autoDisconnect: boolean;
  /** Tracks the last period key for which warning/limit alerts were emitted */
  lastWarnPeriod?: string;
  lastLimitPeriod?: string;
}

export interface UsageHistory {
  /** Last 60 minutes (1-minute buckets) for real-time 1H view */
  minutes: UsageBucket[];
  /** Last 168 hours (7 days of 1-hour buckets) for 24H and 7D views */
  hours: UsageBucket[];
  /** Last 90 days (1-day buckets) for 30D and 90D views */
  days: UsageBucket[];
  /** Persistent per-server cumulative traffic & session duration */
  perServer: Record<string, ServerUsageRecord>;
  /** Configurable data-cap alert & auto-disconnect settings */
  dataCap: DataCapConfig;
  /** Peak 1-second download and upload speeds observed (bytes/sec) */
  peakDownSpeed: number;
  peakUpSpeed: number;
}

export interface SpeedTestResult {
  id: string;
  timestamp: number;
  /** 'vpn' when measured through the tunnel, 'direct' when disconnected. */
  route: 'vpn' | 'direct';
  serverName: string | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  /** Time to open a brand-new HTTPS connection (what a new page load pays). */
  handshakeMs: number | null;
  ip: string | null;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  isp: string | null;
  /** Cloudflare data-centre code that served the test, e.g. "SIN". */
  colo: string | null;
  error?: string;
}
