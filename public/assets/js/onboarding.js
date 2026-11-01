import { brandMark, icon } from './icons.js';
import { escapeHtml } from './ui.js';

/**
 * 5-Step Interactive First-Run Onboarding Experience for Xray VPN Desktop.
 * Shows automatically on first install (when `store.data.onboardingCompleted` is falsy),
 * and can also be replayed anytime from Settings.
 */

const STEPS = [
  {
    step: '01',
    tag: 'CORE ARCHITECTURE',
    title: 'Welcome to DragonForce Vpn',
    lead: 'Engineered for zero-delay web browsing and full-system packet routing powered by Xray-core v26 and Wintun L3.',
    features: [
      {
        icon: 'zap',
        title: 'Zero-Delay Hybrid Routing',
        desc: 'Browsers connect via 0.1 ms loopback HTTP CONNECT while Wintun captures all non-proxy apps, games, and terminals.',
      },
      {
        icon: 'shieldCheck',
        title: 'VLESS, VMess, TLS 1.3 & Reality',
        desc: 'Full support for TCP, WebSocket, gRPC, HTTPUpgrade, XHTTP, and automatic SHA-256 certificate pinning.',
      },
      {
        icon: 'terminal',
        title: '1-Click Terminal Proxy Environment',
        desc: 'Automatically configures HTTP_PROXY and ALL_PROXY for Git, npm, pip, and curl without manual setup.',
      },
    ],
  },
  {
    step: '02',
    tag: 'GLOBAL TELEMETRY',
    title: 'Interactive World Map & Route Arc',
    lead: 'Visualize your encrypted tunnel across a high-precision vector world map with live throughput telemetry.',
    features: [
      {
        icon: 'globe',
        title: 'Geodesic Route Visualization',
        desc: 'Displays a live great-circle arc linking your origin and exit server with traffic-driven particle flow.',
      },
      {
        icon: 'pin',
        title: 'Instant Location Switching & Ping',
        desc: 'Click any marker on the map or sidebar to switch servers and measure real TCP handshake latency.',
      },
      {
        icon: 'network',
        title: 'Exit IP & Tunnel Verification',
        desc: 'Verify end-to-end HTTP 204 tunnel connectivity and inspect your external public IP in real time.',
      },
    ],
  },
  {
    step: '03',
    tag: 'NODE MANAGEMENT',
    title: 'Live Config Editor & Subscriptions',
    lead: 'Customize server parameters on the fly and keep multi-node provider subscriptions synced automatically.',
    features: [
      {
        icon: 'pencil',
        title: 'Full SNI, Bug Host & Remarks Editor',
        desc: 'Edit SNI, Host headers, Path, Port, TLS Fingerprint, or Allow Insecure — changes regenerate the share link immediately.',
      },
      {
        icon: 'rss',
        title: 'Provider Subscription Auto-Sync',
        desc: 'Import Base64 subscription URLs with one-click refresh, node count tracking, and provider quota bars.',
      },
      {
        icon: 'code',
        title: 'Live Xray Core JSON Inspector',
        desc: 'Inspect and copy the exact generated Xray-core inbound/outbound JSON configuration for any server.',
      },
    ],
  },
  {
    step: '04',
    tag: 'MOBILE SYNC & DIAGNOSTICS',
    title: 'QR Code Studio & Speed Checker',
    lead: 'Transfer edited configs to your phone in one scan and benchmark your tunnel with multi-stream speed tests.',
    features: [
      {
        icon: 'qr',
        title: 'Instant Mobile QR Generator',
        desc: 'Generate studio-grade QR codes compatible with v2rayNG, NekoBox, Streisand, Hiddify, and Shadowrocket.',
      },
      {
        icon: 'scan',
        title: 'Screen & Clipboard QR Scanner',
        desc: 'Import servers directly from QR codes visible on your desktop screen, clipboard snips (Win+Shift+S), or image files.',
      },
      {
        icon: 'gauge',
        title: 'Advanced Cloudflare Speed Checker',
        desc: 'Measure multi-stream download/upload Mbps, idle ping, jitter, and new-page HTTPS TLS handshake speed.',
      },
    ],
  },
  {
    step: '05',
    tag: 'TRAFFIC INTELLIGENCE',
    title: 'Usage Analytics & Smart Data Caps',
    lead: 'Track historical bandwidth across restarts with spline telemetry charts and automated quota protection.',
    features: [
      {
        icon: 'chart',
        title: 'Persistent Multi-Range Spline Charts',
        desc: 'Inspect Combined, Download, and Upload traffic across 1H, 1D, 1W, and 1M periods with rolling averages.',
      },
      {
        icon: 'server',
        title: 'Per-Server Bandwidth Breakdown',
        desc: 'See cumulative upload/download bytes, session count, and active connection time for every server.',
      },
      {
        icon: 'bell',
        title: 'Data Cap Alerts & Auto-Disconnect',
        desc: 'Set daily or monthly GB quotas with 80% warning alerts and an optional 100% auto-disconnect kill-switch.',
      },
    ],
  },
];

/**
 * Renders the custom interactive graphical showcase for each onboarding step.
 */
function renderStepShowcase(stepIdx) {
  if (stepIdx === 0) {
    // Step 1: Hybrid Xray-core + Wintun Architecture Diagram
    return `
      <div class="ob-art ob-art-arch">
        <div class="ob-arch-card">
          <div class="ob-arch-row">
            <div class="ob-arch-node">
              <span class="ob-arch-ic">${icon('globe', 16)}</span>
              <div>
                <div class="ob-arch-title">Web Browsers</div>
                <div class="ob-arch-sub">Direct HTTP CONNECT · 0.1 ms</div>
              </div>
              <span class="ob-arch-pill is-teal">Zero Delay</span>
            </div>
            <div class="ob-arch-node">
              <span class="ob-arch-ic">${icon('terminal', 16)}</span>
              <div>
                <div class="ob-arch-title">Apps, Games & CLI</div>
                <div class="ob-arch-sub">Wintun L3 Virtual Adapter</div>
              </div>
              <span class="ob-arch-pill">Full TUN</span>
            </div>
          </div>

          <div class="ob-arch-connector">
            <span class="ob-arch-line"></span>
            <span class="ob-arch-core-badge">${icon('shieldCheck', 15)}<span>Xray-core v26.10 Engine</span></span>
            <span class="ob-arch-line"></span>
          </div>

          <div class="ob-arch-dest">
            <div class="ob-arch-dest-top">
              <span class="status-dot is-on"></span>
              <strong>Encrypted Outbound Tunnel</strong>
              <span class="mono">TLS 1.3 / Reality</span>
            </div>
            <div class="ob-arch-tags">
              <span>VLESS</span><span>VMess</span><span>WebSocket</span><span>gRPC</span><span>TCP</span><span>Cert Pinning</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  if (stepIdx === 1) {
    // Step 2: Interactive World Map & Route Preview
    return `
      <div class="ob-art ob-art-map">
        <div class="ob-map-card">
          <svg class="ob-map-svg" viewBox="0 0 340 190" fill="none" aria-hidden="true">
            <defs>
              <pattern id="obDots" width="10" height="10" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1.2" fill="#CBD7E0" />
              </pattern>
              <linearGradient id="obArcGrad" x1="64" y1="126" x2="258" y2="74" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#087E77" />
                <stop offset="100%" stop-color="#00B9A7" />
              </linearGradient>
            </defs>
            <rect width="340" height="190" rx="14" fill="#F2F6F9" />
            <ellipse cx="95" cy="95" rx="75" ry="52" fill="url(#obDots)" />
            <ellipse cx="235" cy="82" rx="82" ry="58" fill="url(#obDots)" />
            <!-- Route shadow & glowing arc -->
            <path d="M 68 124 Q 162 28 256 78" stroke="rgba(0, 168, 150, 0.16)" stroke-width="6" stroke-linecap="round" fill="none" />
            <path d="M 68 124 Q 162 28 256 78" stroke="url(#obArcGrad)" stroke-width="2.5" stroke-dasharray="5 5" stroke-linecap="round" fill="none" />
            <!-- Flowing particles -->
            <circle cx="122" cy="84" r="3.2" fill="#00A896" />
            <circle cx="188" cy="58" r="3.2" fill="#00A896" />
            <!-- Origin marker -->
            <circle cx="68" cy="124" r="11" fill="#FFFFFF" stroke="#18232D" stroke-width="2" />
            <circle cx="68" cy="124" r="4" fill="#18232D" />
            <!-- Destination pulse & marker -->
            <circle cx="256" cy="78" r="16" fill="rgba(0, 168, 150, 0.18)" />
            <circle cx="256" cy="78" r="7" fill="#00A896" stroke="#FFFFFF" stroke-width="2" />
          </svg>

          <div class="ob-map-float">
            <div class="ob-map-float-head">
              <span class="status-dot is-on"></span>
              <strong>Singapore · SG-01</strong>
              <span class="ob-ping-good num">13 ms</span>
            </div>
            <div class="ob-map-float-sub">2,730 km geodesic arc · VLESS · TLS</div>
          </div>

          <div class="ob-map-stats">
            <div class="ob-mini-stat">
              <span>Download</span>
              <strong class="num">84.6 <small>Mbps</small></strong>
            </div>
            <div class="ob-mini-stat">
              <span>Upload</span>
              <strong class="num">39.2 <small>Mbps</small></strong>
            </div>
          </div>
        </div>
      </div>`;
  }

  if (stepIdx === 2) {
    // Step 3: Server Config Editor & Subscriptions
    return `
      <div class="ob-art ob-art-editor">
        <div class="ob-editor-card">
          <div class="ob-ed-head">
            <strong>Edit Server Configuration</strong>
            <span class="ob-arch-pill is-teal">VLESS · TLS</span>
          </div>
          <div class="ob-ed-grid">
            <div class="ob-ed-field is-span-2">
              <span class="ob-ed-label">Remarks</span>
              <div class="ob-ed-val">Dialog Router · Low Latency SG</div>
            </div>
            <div class="ob-ed-field">
              <span class="ob-ed-label">SNI / Bug Host</span>
              <div class="ob-ed-val mono is-highlight">aka.ms</div>
            </div>
            <div class="ob-ed-field">
              <span class="ob-ed-label">TLS Fingerprint</span>
              <div class="ob-ed-val">Chrome (uTLS)</div>
            </div>
          </div>
          <div class="ob-ed-sub-card">
            <div class="ob-ed-sub-top">
              <span><strong>Premium Subscription</strong> · 12 nodes synced</span>
              <span class="num">42% quota</span>
            </div>
            <div class="ob-ed-quota-bar"><i style="width:42%"></i></div>
          </div>
        </div>
      </div>`;
  }

  if (stepIdx === 3) {
    // Step 4: QR Code Studio & Speed Test
    return `
      <div class="ob-art ob-art-qr">
        <div class="ob-qr-duo">
          <div class="ob-qr-mini">
            <div class="ob-qr-box">
              <svg viewBox="0 0 100 100" width="96" height="96" aria-hidden="true">
                <rect width="100" height="100" rx="10" fill="#FFFFFF" />
                <!-- Top-Left Finder -->
                <rect x="8" y="8" width="26" height="26" rx="6" fill="none" stroke="#152028" stroke-width="4" />
                <rect x="15" y="15" width="12" height="12" rx="3" fill="#00A896" />
                <!-- Top-Right Finder -->
                <rect x="66" y="8" width="26" height="26" rx="6" fill="none" stroke="#152028" stroke-width="4" />
                <rect x="73" y="15" width="12" height="12" rx="3" fill="#00A896" />
                <!-- Bottom-Left Finder -->
                <rect x="8" y="66" width="26" height="26" rx="6" fill="none" stroke="#152028" stroke-width="4" />
                <rect x="15" y="73" width="12" height="12" rx="3" fill="#00A896" />
                <!-- Data dots -->
                <g fill="#152028">
                  <circle cx="44" cy="14" r="3" /><circle cx="52" cy="14" r="3" /><circle cx="44" cy="22" r="3" />
                  <circle cx="58" cy="28" r="3" /><circle cx="14" cy="44" r="3" /><circle cx="22" cy="52" r="3" />
                  <circle cx="30" cy="44" r="3" /><circle cx="72" cy="46" r="3" /><circle cx="84" cy="54" r="3" />
                  <circle cx="46" cy="74" r="3" /><circle cx="56" cy="82" r="3" /><circle cx="70" cy="70" r="3" />
                  <circle cx="82" cy="78" r="3" /><circle cx="74" cy="86" r="3" /><circle cx="86" cy="86" r="3" />
                </g>
                <!-- Center shield badge -->
                <rect x="38" y="38" width="24" height="24" rx="6" fill="#00A896" />
                <path d="M50 43l6 2.5v4.5c0 4-2.6 6.4-6 7.6-3.4-1.2-6-3.6-6-7.6v-4.5L50 43z" fill="none" stroke="#FFF" stroke-width="1.6" />
              </svg>
            </div>
            <div class="ob-qr-mini-caption">v2rayNG · NekoBox · Streisand</div>
          </div>

          <div class="ob-speed-mini">
            <div class="ob-speed-badge">${icon('zap', 13)}<span>Cloudflare Edge</span></div>
            <div class="ob-speed-metric">
              <span>Download</span>
              <strong class="num tone-good">148.4 <small>Mbps</small></strong>
            </div>
            <div class="ob-speed-metric">
              <span>Upload</span>
              <strong class="num">64.2 <small>Mbps</small></strong>
            </div>
            <div class="ob-speed-foot num">Ping 13 ms · TLS 38 ms</div>
          </div>
        </div>
      </div>`;
  }

  // Step 5: Traffic Analytics & Data Cap Alerts
  const bars = Array.from({ length: 24 }, (_, i) => `<i class="${i < 16 ? 'is-on' : ''}"></i>`).join('');
  return `
    <div class="ob-art ob-art-usage">
      <div class="ob-usage-card">
        <div class="ob-usage-top">
          <div>
            <span class="ob-ed-label">Persistent Total Usage</span>
            <div class="ob-usage-big num">1.83 <small>GB</small></div>
          </div>
          <div class="ob-usage-pills"><span>1H</span><span class="is-on">1D</span><span>1W</span><span>1M</span></div>
        </div>

        <svg class="ob-usage-svg" viewBox="0 0 300 92" fill="none" aria-hidden="true">
          <!-- Vertical hairline texture -->
          ${Array.from({ length: 36 }, (_, i) => {
            const x = 6 + i * 8.2;
            const h = 24 + ((i * 17) % 48);
            return `<line x1="${x}" y1="${86 - h}" x2="${x}" y2="86" stroke="#E4ECEF" stroke-width="1.5" />`;
          }).join('')}
          <!-- Rolling average curve -->
          <path d="M 6 68 C 55 62, 95 44, 145 48 C 195 52, 240 28, 294 34" stroke="#9AA8B4" stroke-width="1.8" fill="none" />
          <!-- Current usage spline curve -->
          <path d="M 6 72 C 48 50, 96 26, 148 38 C 198 48, 238 18, 294 22" stroke="#F59E0B" stroke-width="2.4" fill="none" />
          <circle cx="218" cy="27" r="4.5" fill="#F59E0B" stroke="#FFFFFF" stroke-width="2" />
        </svg>

        <div class="ob-cap-strip">
          <div class="ob-cap-head">
            <span>Monthly Quota Protection</span>
            <strong class="num">66.7% · 50 GB Cap</strong>
          </div>
          <div class="ob-cap-bars">${bars}</div>
        </div>
      </div>
    </div>`;
}

/**
 * Opens the multi-step onboarding modal.
 */
export function openOnboardingModal({ store, api, onComplete, onOpenQrScanner }) {
  const root = document.getElementById('modal-root');
  let stepIdx = 0;
  let chosenMode = store.status?.routingMode || store.data?.routingMode || (store.status?.isAdmin ? 'tun' : 'system_proxy');

  async function finishOnboarding(nextAction) {
    try {
      localStorage.setItem('xray_vpn_onboarded_v1', '1');
    } catch {
      /* ignore */
    }
    if (chosenMode && chosenMode !== store.status?.routingMode) {
      await api('/api/routing-mode', { mode: chosenMode }).catch(() => {});
    }
    await api('/api/onboarding', { completed: true }).catch(() => {});
    if (store.data) store.data.onboardingCompleted = true;
    document.removeEventListener('keydown', onKeyDown);
    root.innerHTML = '';
    if (nextAction) nextAction();
    else if (onComplete) onComplete();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      if (stepIdx < STEPS.length - 1) {
        stepIdx++;
        render();
      } else {
        finishOnboarding();
      }
    } else if (e.key === 'ArrowLeft' && stepIdx > 0) {
      e.preventDefault();
      stepIdx--;
      render();
    } else if (e.key === 'Escape') {
      finishOnboarding();
    }
  }

  function render() {
    const s = STEPS[stepIdx];
    const isLast = stepIdx === STEPS.length - 1;
    const isAdmin = !!store.status?.isAdmin;

    const featuresHtml = s.features
      .map(
        (f) => `
        <div class="ob-feat-item">
          <div class="ob-icon-box">${icon(f.icon, 18)}</div>
          <div class="ob-feat-copy">
            <div class="ob-feat-title">${escapeHtml(f.title)}</div>
            <div class="ob-feat-desc">${escapeHtml(f.desc)}</div>
          </div>
        </div>`
      )
      .join('');

    const dotsHtml = STEPS.map(
      (item, idx) => `
      <button
        type="button"
        class="ob-dot ${idx === stepIdx ? 'is-active' : idx < stepIdx ? 'is-done' : ''}"
        data-act="goto"
        data-idx="${idx}"
        aria-label="Step ${idx + 1}: ${escapeHtml(item.title)}"
        title="${escapeHtml(item.title)}"
      ></button>`
    ).join('');

    root.innerHTML = `
    <div class="modal ob-backdrop">
      <div class="panel modal-box ob-modal" role="dialog" aria-modal="true" aria-label="Welcome to DragonForce Vpn">
        <!-- Left Column: Visual Showcase & Step Progress -->
        <div class="ob-left">
          <div class="ob-left-top">
            <span class="ob-step-badge">STEP ${s.step} OF 0${STEPS.length} · ${s.tag}</span>
          </div>

          <div class="ob-showcase-stage">
            ${renderStepShowcase(stepIdx)}
          </div>

          <div class="ob-left-foot">
            <span class="ob-admin-pill ${isAdmin ? 'is-admin' : ''}">
              ${icon(isAdmin ? 'shieldCheck' : 'shield', 14)}
              <span>${isAdmin ? 'Administrator · Wintun L3 Ready' : 'Standard Mode · System Proxy Ready'}</span>
            </span>
          </div>
        </div>

        <!-- Right Column: Feature Breakdown & Navigation -->
        <div class="ob-right">
          <div class="ob-right-head">
            <div class="ob-brand-row">
              ${brandMark(30)}
              <span>DragonForce Vpn</span>
            </div>
            <button type="button" class="btn btn-ghost btn-sm ob-skip-btn" data-act="skip">Skip tour</button>
          </div>

          <div class="ob-copy-head">
            <h2>${escapeHtml(s.title)}</h2>
            <p>${escapeHtml(s.lead)}</p>
          </div>

          <div class="ob-feat-list">
            ${featuresHtml}
          </div>

          ${
            isLast
              ? `
          <div class="ob-mode-picker">
            <span class="ob-mode-label">Preferred Default Routing Mode</span>
            <div class="ob-mode-grid">
              <button type="button" class="ob-mode-btn ${chosenMode === 'tun' ? 'is-selected' : ''}" data-act="pick-mode" data-mode="tun">
                <div class="ob-mode-ic">${icon('terminal', 15)}</div>
                <div class="ob-mode-txt">
                  <strong>Full TUN + Hybrid Proxy</strong>
                  <span>Routes all apps, browsers & CLI</span>
                </div>
              </button>
              <button type="button" class="ob-mode-btn ${chosenMode === 'system_proxy' ? 'is-selected' : ''}" data-act="pick-mode" data-mode="system_proxy">
                <div class="ob-mode-ic">${icon('globe', 15)}</div>
                <div class="ob-mode-txt">
                  <strong>System Proxy Only</strong>
                  <span>Browsers & proxy-aware apps</span>
                </div>
              </button>
            </div>
          </div>`
              : ''
          }

          <div class="ob-footer">
            <div class="ob-dots" role="tablist" aria-label="Onboarding steps">
              ${dotsHtml}
            </div>

            <div class="ob-nav-actions">
              ${
                stepIdx > 0
                  ? `<button type="button" class="btn" data-act="prev">${icon('chevronLeft', 15)}Back</button>`
                  : ''
              }
              ${
                isLast
                  ? `<button type="button" class="btn" data-act="finish-qr" title="Scan a QR code right away">${icon('qr', 15)}Scan QR</button>
                     <button type="button" class="btn btn-primary ob-next-btn" data-act="finish">${icon('check', 16)}Get Started</button>`
                  : `<button type="button" class="btn btn-primary ob-next-btn" data-act="next">Next${icon('chevronRight', 15)}</button>`
              }
            </div>
          </div>
        </div>
      </div>
    </div>`;

    root.querySelector('.ob-modal').onclick = (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'next':
          if (stepIdx < STEPS.length - 1) {
            stepIdx++;
            render();
          }
          break;
        case 'prev':
          if (stepIdx > 0) {
            stepIdx--;
            render();
          }
          break;
        case 'goto':
          stepIdx = Number(btn.dataset.idx) || 0;
          render();
          break;
        case 'pick-mode':
          chosenMode = btn.dataset.mode;
          render();
          break;
        case 'skip':
        case 'finish':
          finishOnboarding();
          break;
        case 'finish-qr':
          finishOnboarding(() => onOpenQrScanner?.());
          break;
      }
    };
  }

  document.addEventListener('keydown', onKeyDown);
  render();
}
