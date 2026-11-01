import { icon } from './icons.js';
import { renderQrToCanvas, scanQrFromCanvas } from './qr-codec.js';
import { copyText, escapeHtml, flagHtml, locationLabel, toast } from './ui.js';

/**
 * Generates a high-DPI shareable PNG card combining the QR code with server
 * metadata (Remarks, Protocol/Transport/Security, Address:Port, SNI/Host).
 */
function buildShareCardCanvas(node, qrStyle, showLogo) {
  const qrCanvas = document.createElement('canvas');
  renderQrToCanvas(qrCanvas, node.rawUri, {
    style: qrStyle,
    showLogo,
    sizePx: 520,
  });

  const card = document.createElement('canvas');
  const w = 680;
  const h = 820;
  card.width = w;
  card.height = h;
  const ctx = card.getContext('2d');

  ctx.fillStyle = '#F6F8FA';
  ctx.fillRect(0, 0, w, h);

  const roundRect = (x, y, rw, rh, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx.arcTo(x, y + rh, x, y, r);
    ctx.arcTo(x, y, x + rw, y, r);
    ctx.closePath();
  };

  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#E4EAED';
  ctx.lineWidth = 2;
  roundRect(32, 32, w - 64, h - 64, 28);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#E6F6F4';
  roundRect(68, 64, 212, 34, 17);
  ctx.fill();
  ctx.fillStyle = '#087E77';
  ctx.font = '600 13px Poppins, Segoe UI, sans-serif';
  ctx.fillText('DRAGONFORCE VPN PASS', 84, 86);

  const protoText = `${node.protocol.toUpperCase()} · ${node.network.toUpperCase()} · ${(node.security || 'none').toUpperCase()}`;
  ctx.font = '600 13px Poppins, Segoe UI, sans-serif';
  const pw = ctx.measureText(protoText).width + 28;
  ctx.fillStyle = '#F1F5F7';
  roundRect(w - 68 - pw, 64, pw, 34, 17);
  ctx.fill();
  ctx.fillStyle = '#4A5965';
  ctx.fillText(protoText, w - 68 - pw + 14, 86);

  ctx.fillStyle = '#152028';
  ctx.font = '600 26px Poppins, Segoe UI, sans-serif';
  const title = node.name.length > 32 ? node.name.slice(0, 31) + '…' : node.name;
  ctx.fillText(title, 68, 140);

  ctx.fillStyle = '#6A7885';
  ctx.font = '500 14px Consolas, monospace';
  const sniInfo = node.sni || node.host ? `  ·  SNI: ${node.sni || node.host}` : '';
  const sub = `${node.address}:${node.port}${sniInfo}`;
  ctx.fillText(sub.length > 56 ? sub.slice(0, 55) + '…' : sub, 68, 168);

  const qrBoxSize = 500;
  const qx = Math.round((w - qrBoxSize) / 2);
  const qy = 196;
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#E4EAED';
  ctx.lineWidth = 2;
  roundRect(qx, qy, qrBoxSize, qrBoxSize, 22);
  ctx.fill();
  ctx.stroke();

  ctx.drawImage(qrCanvas, qx + 14, qy + 14, qrBoxSize - 28, qrBoxSize - 28);

  ctx.fillStyle = '#6A7885';
  ctx.font = '500 14px Poppins, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Scan with v2rayNG, NekoBox, Streisand, Hiddify, or DragonForce Vpn', w / 2, 742);
  ctx.textAlign = 'start';

  return card;
}

/**
 * Opens the unified QR Code Studio Modal:
 * - Tab 1 (`share`): Perfectly aligned 2-column Server QR Pass & Export Studio
 * - Tab 2 (`scan`): Clean Light-Theme Optical Scanner & 4-Source Capture Grid
 */
export function openQrModal({
  initialTab = 'share',
  serverId = null,
  store,
  api,
  onEditServer,
  onImported,
}) {
  const root = document.getElementById('modal-root');
  const servers = store.data.servers || [];
  let activeTab = initialTab === 'scan' || !servers.length ? 'scan' : 'share';
  let currentServerId = serverId || store.status?.activeServerId || servers[0]?.id || null;
  let qrStyle = 'modern';
  let showLogo = true;

  // Scanner state
  let scanStatus = 'Ready to scan';
  let scanSub = 'Choose a capture source on the right or press Ctrl+V to paste a QR image';
  let scanTone = 'neutral';
  let isScanning = false;
  let previewResult = null;
  let cameraStream = null;
  let cameraTimer = 0;

  function stopCamera() {
    if (cameraTimer) {
      clearInterval(cameraTimer);
      cameraTimer = 0;
    }
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
      cameraStream = null;
    }
  }

  function close() {
    stopCamera();
    root.innerHTML = '';
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('paste', onGlobalPaste);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
    if (activeTab === 'share' && servers.length > 1) {
      if (e.key === 'ArrowLeft') cycleServer(-1);
      else if (e.key === 'ArrowRight') cycleServer(1);
    }
  }

  function cycleServer(delta) {
    if (!servers.length) return;
    const idx = Math.max(0, servers.findIndex((s) => s.id === currentServerId));
    const nextIdx = (idx + delta + servers.length) % servers.length;
    currentServerId = servers[nextIdx].id;
    render();
  }

  function currentNode() {
    return (store.data.servers || []).find((s) => s.id === currentServerId) || store.data.servers?.[0] || null;
  }

  // ---------------------------------------------------------------------------
  // QR Scanning Pipeline
  // ---------------------------------------------------------------------------

  async function handleDecodedText(rawText, sourceLabel = 'QR code') {
    const cleaned = String(rawText || '').trim();
    if (!cleaned) return false;
    isScanning = true;
    scanStatus = 'Validating QR payload…';
    scanSub = `Source: ${sourceLabel}`;
    scanTone = 'accent';
    updateScannerDom();

    const preview = await api('/api/qr/preview', { rawText: cleaned });
    isScanning = false;
    previewResult = { ...preview, rawText: cleaned, sourceLabel };

    if (preview.ok && preview.kind === 'servers') {
      scanStatus = `${preview.nodes.length} Server Config${preview.nodes.length === 1 ? '' : 's'} Decoded`;
      scanSub = `Verified from ${sourceLabel} · Ready to import`;
      scanTone = 'good';
    } else if (preview.ok && preview.kind === 'subscription') {
      scanStatus = 'Subscription URL Decoded';
      scanSub = `Verified from ${sourceLabel} · Ready to sync`;
      scanTone = 'good';
    } else {
      scanStatus = 'Unrecognized QR Payload';
      scanSub = preview.error || 'QR code does not contain a VLESS/VMess share link';
      scanTone = 'bad';
    }
    updateScannerDom();
    return preview.ok;
  }

  async function scanImageElement(img, sourceLabel) {
    const stageCanvas = root.querySelector('[data-ref="scanCanvas"]');
    const videoEl = root.querySelector('[data-ref="scanVideo"]');
    const emptyEl = root.querySelector('[data-ref="scanEmpty"]');
    const resetBtn = root.querySelector('[data-ref="resetScanBtn"]');
    if (!stageCanvas) return;

    stopCamera();
    if (videoEl) videoEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;
    if (resetBtn) resetBtn.hidden = false;
    stageCanvas.hidden = false;

    const maxDim = 1920;
    const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
    stageCanvas.width = Math.max(1, Math.round(img.width * scale));
    stageCanvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = stageCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, stageCanvas.width, stageCanvas.height);

    stageCanvas._sourceImage = img;

    isScanning = true;
    scanStatus = `Scanning ${sourceLabel}…`;
    scanSub = `Analyzing ${img.width}×${img.height} image matrix`;
    scanTone = 'accent';
    updateScannerDom();

    const hit = await scanQrFromCanvas(stageCanvas);
    if (hit?.text) {
      if (hit.bounds) {
        ctx.save();
        ctx.strokeStyle = '#00A896';
        ctx.lineWidth = Math.max(3, Math.round(stageCanvas.width / 220));
        ctx.fillStyle = 'rgba(0, 168, 150, 0.14)';
        const { x, y, width, height } = hit.bounds;
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x, y, width, height);
        ctx.restore();
      }
      await handleDecodedText(hit.text, sourceLabel);
    } else {
      isScanning = false;
      scanStatus = 'No QR code detected automatically';
      scanSub = 'Tip: Drag a box directly over the QR code in the preview on the left to zoom-scan it.';
      scanTone = 'warn';
      updateScannerDom();
    }
  }

  function loadDataUrlIntoScanner(dataUrl, sourceLabel) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = async () => {
        await scanImageElement(img, sourceLabel);
        resolve(true);
      };
      img.onerror = () => {
        scanStatus = 'Could not read image';
        scanSub = `Failed to load image from ${sourceLabel}`;
        scanTone = 'bad';
        updateScannerDom();
        resolve(false);
      };
      img.src = dataUrl;
    });
  }

  async function scanFromClipboard() {
    isScanning = true;
    scanStatus = 'Reading clipboard…';
    scanSub = 'Checking Windows clipboard for QR image or share URI';
    scanTone = 'accent';
    updateScannerDom();

    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await item.getType(imgType);
            const url = URL.createObjectURL(blob);
            await loadDataUrlIntoScanner(url, 'Clipboard image');
            URL.revokeObjectURL(url);
            return;
          }
        }
      }
    } catch {
      /* fallback to native Windows clipboard bridge */
    }

    const osClip = await api('/api/qr/clipboard', {});
    if (osClip?.ok && osClip.kind === 'image' && osClip.dataUrl) {
      await loadDataUrlIntoScanner(osClip.dataUrl, 'Clipboard image');
      return;
    }
    if (osClip?.ok && osClip.kind === 'text' && osClip.text) {
      await handleDecodedText(osClip.text, 'Clipboard link');
      return;
    }

    try {
      const txt = await navigator.clipboard.readText();
      if (txt && txt.trim()) {
        await handleDecodedText(txt.trim(), 'Clipboard link');
        return;
      }
    } catch {
      /* ignore */
    }

    isScanning = false;
    scanStatus = 'Clipboard is empty';
    scanSub = 'Copy a QR image (or snip with Win+Shift+S) and click Paste Clipboard again';
    scanTone = 'warn';
    updateScannerDom();
  }

  async function scanFromScreen() {
    isScanning = true;
    scanStatus = 'Capturing desktop screen…';
    scanSub = 'Scanning visible windows for QR codes';
    scanTone = 'accent';
    updateScannerDom();

    const cap = await api('/api/qr/capture-screen', { delayMs: 120 });
    if (cap?.ok && cap.dataUrl) {
      await loadDataUrlIntoScanner(cap.dataUrl, 'Desktop screen');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never' },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 120));

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = video.videoWidth || 1920;
      tempCanvas.height = video.videoHeight || 1080;
      tempCanvas.getContext('2d').drawImage(video, 0, 0);
      track.stop();

      await loadDataUrlIntoScanner(tempCanvas.toDataURL('image/png'), 'Captured screen');
    } catch {
      isScanning = false;
      scanStatus = 'Screen capture cancelled';
      scanSub = 'Tip: You can also press Win+Shift+S to snip any QR code and click Paste Clipboard';
      scanTone = 'warn';
      updateScannerDom();
    }
  }

  async function toggleCamera() {
    if (cameraStream) {
      stopCamera();
      render();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraStream = stream;
      const videoEl = root.querySelector('[data-ref="scanVideo"]');
      const stageCanvas = root.querySelector('[data-ref="scanCanvas"]');
      const emptyEl = root.querySelector('[data-ref="scanEmpty"]');
      const camBtn = root.querySelector('[data-act="scan-camera"]');
      if (emptyEl) emptyEl.hidden = true;
      if (stageCanvas) stageCanvas.hidden = true;
      if (videoEl) {
        videoEl.hidden = false;
        videoEl.srcObject = stream;
        await videoEl.play();
      }
      if (camBtn) camBtn.classList.add('is-active');
      scanStatus = 'Camera active';
      scanSub = 'Hold the QR code steady inside the viewfinder frame';
      scanTone = 'accent';
      updateScannerDom();

      const frameCanvas = document.createElement('canvas');
      cameraTimer = setInterval(async () => {
        if (!videoEl || videoEl.readyState < 2 || isScanning) return;
        frameCanvas.width = videoEl.videoWidth || 640;
        frameCanvas.height = videoEl.videoHeight || 480;
        frameCanvas.getContext('2d').drawImage(videoEl, 0, 0);
        const hit = await scanQrFromCanvas(frameCanvas);
        if (hit?.text) {
          stopCamera();
          if (videoEl) videoEl.hidden = true;
          if (stageCanvas) {
            stageCanvas.hidden = false;
            stageCanvas.width = frameCanvas.width;
            stageCanvas.height = frameCanvas.height;
            stageCanvas.getContext('2d').drawImage(frameCanvas, 0, 0);
          }
          await handleDecodedText(hit.text, 'Live camera');
        }
      }, 220);
    } catch {
      toast('Camera unavailable or permission denied', 'error');
    }
  }

  function onGlobalPaste(e) {
    if (activeTab !== 'scan') return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const url = URL.createObjectURL(file);
          loadDataUrlIntoScanner(url, 'Pasted image').finally(() => URL.revokeObjectURL(url));
        }
        return;
      }
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      handleDecodedText(text.trim(), 'Pasted text');
    }
  }

  function bindCanvasCrop(stageCanvas) {
    let startPt = null;
    stageCanvas.addEventListener('mousedown', (e) => {
      if (!stageCanvas._sourceImage) return;
      const rect = stageCanvas.getBoundingClientRect();
      startPt = {
        x: ((e.clientX - rect.left) / rect.width) * stageCanvas.width,
        y: ((e.clientY - rect.top) / rect.height) * stageCanvas.height,
      };
    });
    stageCanvas.addEventListener('mousemove', (e) => {
      if (!startPt || !stageCanvas._sourceImage) return;
      const rect = stageCanvas.getBoundingClientRect();
      const curX = ((e.clientX - rect.left) / rect.width) * stageCanvas.width;
      const curY = ((e.clientY - rect.top) / rect.height) * stageCanvas.height;
      const ctx = stageCanvas.getContext('2d');
      ctx.drawImage(stageCanvas._sourceImage, 0, 0, stageCanvas.width, stageCanvas.height);
      const x = Math.min(startPt.x, curX);
      const y = Math.min(startPt.y, curY);
      const w = Math.abs(curX - startPt.x);
      const h = Math.abs(curY - startPt.y);
      ctx.save();
      ctx.fillStyle = 'rgba(21, 32, 40, 0.35)';
      ctx.fillRect(0, 0, stageCanvas.width, stageCanvas.height);
      ctx.drawImage(
        stageCanvas._sourceImage,
        (x / stageCanvas.width) * stageCanvas._sourceImage.width,
        (y / stageCanvas.height) * stageCanvas._sourceImage.height,
        (w / stageCanvas.width) * stageCanvas._sourceImage.width,
        (h / stageCanvas.height) * stageCanvas._sourceImage.height,
        x,
        y,
        w,
        h
      );
      ctx.strokeStyle = '#00A896';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    });
    stageCanvas.addEventListener('mouseup', async (e) => {
      if (!startPt || !stageCanvas._sourceImage) return;
      const rect = stageCanvas.getBoundingClientRect();
      const curX = ((e.clientX - rect.left) / rect.width) * stageCanvas.width;
      const curY = ((e.clientY - rect.top) / rect.height) * stageCanvas.height;
      const x = Math.max(0, Math.min(startPt.x, curX));
      const y = Math.max(0, Math.min(startPt.y, curY));
      const w = Math.min(stageCanvas.width - x, Math.abs(curX - startPt.x));
      const h = Math.min(stageCanvas.height - y, Math.abs(curY - startPt.y));
      startPt = null;
      if (w < 24 || h < 24) return;

      const srcImg = stageCanvas._sourceImage;
      const sx = (x / stageCanvas.width) * srcImg.width;
      const sy = (y / stageCanvas.height) * srcImg.height;
      const sw = (w / stageCanvas.width) * srcImg.width;
      const sh = (h / stageCanvas.height) * srcImg.height;

      const crop = document.createElement('canvas');
      crop.width = Math.max(320, Math.round(sw * 2));
      crop.height = Math.max(320, Math.round(sh * 2));
      const cctx = crop.getContext('2d');
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

      const hit = await scanQrFromCanvas(crop);
      if (hit?.text) {
        await handleDecodedText(hit.text, 'Selected region');
      } else {
        scanStatus = 'No QR code found in selection';
        scanSub = 'Try dragging slightly wider around the white border of the QR code';
        scanTone = 'warn';
        updateScannerDom();
      }
    });
  }

  function updateScannerDom() {
    const bannerEl = root.querySelector('[data-ref="scanBanner"]');
    const stageEl = root.querySelector('[data-ref="scanStage"]');
    const box = root.querySelector('[data-ref="scanResultBox"]');

    if (stageEl) {
      stageEl.classList.toggle('is-scanning', isScanning);
    }

    if (bannerEl) {
      bannerEl.className = `qr-status-card is-${scanTone}`;
      bannerEl.innerHTML = `
        <span class="qr-status-indicator"></span>
        <div class="qr-status-copy">
          <strong>${escapeHtml(scanStatus)}</strong>
          <span>${escapeHtml(scanSub)}</span>
        </div>`;
    }

    if (!box) return;

    if (!previewResult) {
      box.innerHTML = `
        <div class="qr-inspector-placeholder">
          <div class="qr-placeholder-head">
            <span class="qr-placeholder-icon">${icon('shield', 18)}</span>
            <div>
              <strong>Decoded Server Inspector</strong>
              <span>Server parameters will appear here automatically upon detection</span>
            </div>
          </div>
          <div class="qr-placeholder-grid">
            <div class="qr-ph-cell"><span>Protocol</span><strong>VLESS / VMess</strong></div>
            <div class="qr-ph-cell"><span>Transport</span><strong>TCP / WS / gRPC</strong></div>
            <div class="qr-ph-cell"><span>Security</span><strong>TLS / Reality</strong></div>
            <div class="qr-ph-cell"><span>Subscriptions</span><strong>HTTPS Base64</strong></div>
          </div>
        </div>`;
      return;
    }

    if (previewResult.ok && previewResult.kind === 'servers') {
      const cards = previewResult.nodes
        .map(
          (n) => `
          <div class="qr-detected-node">
            <div class="qr-detected-head">
              <div style="min-width:0">
                <strong>${escapeHtml(n.name)}</strong>
                <div class="mono">${escapeHtml(n.address)}:${n.port}</div>
              </div>
              <div class="tags">
                <span class="tag is-accent">${escapeHtml(n.protocol)}</span>
                <span class="tag">${escapeHtml(n.network)}</span>
                ${n.security !== 'none' ? `<span class="tag">${escapeHtml(n.security)}</span>` : ''}
              </div>
            </div>
            <div class="qr-detected-meta">
              <div><span>SNI</span><strong class="mono">${escapeHtml(n.sni || '—')}</strong></div>
              <div><span>Host</span><strong class="mono">${escapeHtml(n.host || '—')}</strong></div>
            </div>
          </div>`
        )
        .join('');

      box.innerHTML = `
        <div class="qr-result-ready">
          <div class="qr-detected-list">${cards}</div>
          <div class="qr-action-grid">
            <button type="button" class="btn btn-primary" data-act="confirm-import">${icon('plus', 16)}Import ${previewResult.nodes.length === 1 ? 'Server' : `${previewResult.nodes.length} Servers`}</button>
            ${
              previewResult.nodes.length === 1
                ? `<button type="button" class="btn" data-act="confirm-import-edit">${icon('pencil', 15)}Import & Edit Config</button>`
                : `<button type="button" class="btn" data-act="copy-decoded">${icon('copy', 15)}Copy Raw Links</button>`
            }
          </div>
        </div>`;
      return;
    }

    if (previewResult.ok && previewResult.kind === 'subscription') {
      box.innerHTML = `
        <div class="qr-result-ready">
          <div class="qr-uri-bar">
            <span class="qr-uri-text mono">${escapeHtml(previewResult.url)}</span>
            <button type="button" class="btn btn-sm" data-act="copy-decoded">${icon('copy', 14)}Copy</button>
          </div>
          <div class="qr-action-grid">
            <button type="button" class="btn btn-primary" style="grid-column: 1 / -1" data-act="confirm-sub">${icon('rss', 16)}Sync & Add Subscription</button>
          </div>
        </div>`;
      return;
    }

    box.innerHTML = `
      <div class="qr-result-ready">
        <div class="qr-uri-bar">
          <span class="qr-uri-text mono">${escapeHtml(previewResult.rawText)}</span>
          <button type="button" class="btn btn-sm" data-act="copy-decoded">${icon('copy', 14)}Copy</button>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Render Modal Shell
  // ---------------------------------------------------------------------------

  function render() {
    stopCamera();
    const node = currentNode();
    const serverIdx = node ? Math.max(0, servers.findIndex((s) => s.id === node.id)) : 0;

    root.innerHTML = `
    <div class="modal" data-close>
      <div class="panel modal-box qr-studio" role="dialog" aria-modal="true" aria-label="QR Code Studio">
        <div class="modal-head qr-studio-head">
          <div class="qr-studio-title">
            <span class="qr-head-icon">${icon('qr', 18)}</span>
            <div>
              <h3>QR Code Studio</h3>
              <div class="form-hint">Share configs with mobile apps or scan QR codes from screen & clipboard</div>
            </div>
          </div>
          <div class="qr-head-controls">
            <div class="segmented" role="tablist" aria-label="QR Mode">
              <button type="button" role="tab" data-act="tab" data-tab="share" aria-selected="${activeTab === 'share'}" aria-pressed="${activeTab === 'share'}" ${!servers.length ? 'disabled title="Add a server first"' : ''}>
                ${icon('qr', 15)}Share QR
              </button>
              <button type="button" role="tab" data-act="tab" data-tab="scan" aria-selected="${activeTab === 'scan'}" aria-pressed="${activeTab === 'scan'}">
                ${icon('scan', 15)}Scan QR
              </button>
            </div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x', 16)}</button>
          </div>
        </div>

        ${
          activeTab === 'share' && node
            ? `
        <div class="qr-studio-body">
          <!-- Left Column: Studio QR Frame + Controls -->
          <div class="qr-left-panel">
            <div class="qr-card-frame">
              <span class="qr-corner tl"></span>
              <span class="qr-corner tr"></span>
              <span class="qr-corner bl"></span>
              <span class="qr-corner br"></span>
              <canvas data-ref="qrCanvas" class="qr-canvas"></canvas>
            </div>

            <div class="qr-style-toolbar">
              <div class="segmented qr-segmented-sm" role="group" aria-label="QR Matrix Style">
                <button type="button" data-act="qr-style" data-style="modern" aria-pressed="${qrStyle === 'modern'}">Studio Dots</button>
                <button type="button" data-act="qr-style" data-style="classic" aria-pressed="${qrStyle === 'classic'}">Classic Crisp</button>
              </div>
              <button type="button" class="btn btn-sm qr-logo-toggle ${showLogo ? 'is-selected-chip' : ''}" data-act="toggle-logo" title="Toggle center shield badge (25% Reed-Solomon EC-Q)">
                ${icon('shieldCheck', 14)}<span>Logo</span>
              </button>
            </div>

            <div class="qr-spec-caption mono" data-ref="qrSpec">ISO/IEC 18004</div>
          </div>

          <!-- Right Column: Perfectly Aligned Server Details & Export -->
          <div class="qr-right-panel">
            <div class="qr-server-switcher">
              <div class="cell-server" style="min-width:0">
                ${flagHtml(node.geo?.countryCode, 34)}
                <div style="min-width:0">
                  <div class="qr-server-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</div>
                  <div class="qr-server-loc">${node.geo ? escapeHtml(locationLabel(node.geo)) : escapeHtml(node.address)}</div>
                </div>
              </div>
              ${
                servers.length > 1
                  ? `<div class="qr-nav-btns">
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="prev-server" title="Previous server (←)">${icon('chevronLeft', 16)}</button>
                      <span class="qr-nav-count num">${serverIdx + 1} / ${servers.length}</span>
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="next-server" title="Next server (→)">${icon('chevronRight', 16)}</button>
                    </div>`
                  : ''
              }
            </div>

            <div class="qr-telemetry-grid">
              <div class="qr-tel-item">
                <span>Protocol & Transport</span>
                <strong>${escapeHtml(node.protocol.toUpperCase())} · ${escapeHtml(node.network.toUpperCase())} · ${escapeHtml((node.security || 'none').toUpperCase())}</strong>
              </div>
              <div class="qr-tel-item">
                <span>Server Endpoint</span>
                <strong class="mono">${escapeHtml(node.address)}:${node.port}</strong>
              </div>
              <div class="qr-tel-item">
                <span>SNI / Bug Host</span>
                <strong class="mono">${escapeHtml(node.sni || node.host || 'Default')}</strong>
              </div>
              <div class="qr-tel-item">
                <span>TLS Mode</span>
                <strong>${node.allowInsecure ? '<span class="tone-fair">Pinned / Allow Insecure</span>' : escapeHtml(node.fingerprint || 'Chrome TLS')}</strong>
              </div>
            </div>

            <div class="qr-compat-box">
              <div class="qr-compat-head">
                <span>${icon('smartphone', 15)}Compatible Mobile Apps</span>
                <button type="button" class="link-btn" data-act="edit-current">${icon('pencil', 13)}Edit SNI / Remarks</button>
              </div>
              <div class="qr-compat-apps">
                <span class="qr-app-pill">v2rayNG</span>
                <span class="qr-app-pill">NekoBox</span>
                <span class="qr-app-pill">Streisand</span>
                <span class="qr-app-pill">Hiddify</span>
                <span class="qr-app-pill">Shadowrocket</span>
              </div>
            </div>

            <div class="qr-uri-section">
              <div class="qr-uri-label">
                <span>Share Link URI</span>
                <span class="qr-uri-sub">Updates automatically when edited</span>
              </div>
              <div class="qr-uri-bar">
                <input type="text" class="qr-uri-input mono" readonly value="${escapeHtml(node.rawUri)}" aria-label="Share link URI" />
                <button type="button" class="btn btn-sm qr-uri-copy" data-act="copy-qr-uri" title="Copy share link">${icon('copy', 14)}Copy URI</button>
              </div>
            </div>

            <div class="qr-action-grid">
              <button type="button" class="btn btn-primary" data-act="copy-qr-img">${icon('image', 16)}Copy QR Image</button>
              <button type="button" class="btn" data-act="save-qr-png">${icon('download', 16)}Save PNG Card</button>
            </div>
          </div>
        </div>`
            : `
        <div class="qr-studio-body qr-scanner-layout">
          <!-- Left Column: Light-Theme Optical Viewfinder -->
          <div class="qr-left-panel">
            <div class="qr-viewfinder" data-ref="scanStage">
              <span class="qr-corner tl"></span>
              <span class="qr-corner tr"></span>
              <span class="qr-corner bl"></span>
              <span class="qr-corner br"></span>
              <div class="qr-laser"></div>

              <div class="qr-viewfinder-empty" data-ref="scanEmpty">
                <div class="qr-vf-icon">${icon('scan', 26)}</div>
                <strong>Optical QR Viewfinder</strong>
                <span>Drop a QR image file here or press <kbd>Ctrl</kbd>+<kbd>V</kbd></span>
              </div>

              <canvas data-ref="scanCanvas" class="qr-scan-canvas" hidden title="Drag a box over any QR code to zoom-scan that region"></canvas>
              <video data-ref="scanVideo" class="qr-scan-video" playsinline muted hidden></video>
              <button type="button" class="btn btn-sm qr-reset-preview" data-ref="resetScanBtn" data-act="reset-scan" hidden>${icon('refresh', 13)}Clear</button>
              <input type="file" data-ref="fileInput" accept="image/*" hidden />
            </div>

            <div class="qr-source-grid">
              <button type="button" class="qr-source-card is-primary" data-act="scan-clipboard">
                <span class="qr-src-icon">${icon('clipboard', 17)}</span>
                <div class="qr-src-text">
                  <strong>Paste Clipboard</strong>
                  <span>Ctrl+V or Win+Shift+S</span>
                </div>
              </button>
              <button type="button" class="qr-source-card" data-act="scan-screen">
                <span class="qr-src-icon">${icon('monitor', 17)}</span>
                <div class="qr-src-text">
                  <strong>Scan Screen</strong>
                  <span>Capture open window</span>
                </div>
              </button>
              <button type="button" class="qr-source-card" data-act="scan-file">
                <span class="qr-src-icon">${icon('image', 17)}</span>
                <div class="qr-src-text">
                  <strong>Browse Image</strong>
                  <span>PNG, JPG, WebP</span>
                </div>
              </button>
              <button type="button" class="qr-source-card" data-act="scan-camera">
                <span class="qr-src-icon">${icon('camera', 17)}</span>
                <div class="qr-src-text">
                  <strong>Web Camera</strong>
                  <span>Live video scan</span>
                </div>
              </button>
            </div>
          </div>

          <!-- Right Column: Aligned Status Banner & Decoded Config Inspector -->
          <div class="qr-right-panel">
            <div class="qr-status-card is-${scanTone}" data-ref="scanBanner"></div>
            <div class="qr-scan-result-wrap" data-ref="scanResultBox"></div>
          </div>
        </div>`
        }
      </div>
    </div>`;

    if (activeTab === 'share' && node) {
      const qrCanvas = root.querySelector('[data-ref="qrCanvas"]');
      const specEl = root.querySelector('[data-ref="qrSpec"]');
      if (qrCanvas) {
        try {
          const qr = renderQrToCanvas(qrCanvas, node.rawUri, {
            style: qrStyle,
            showLogo,
            sizePx: 320,
          });
          if (specEl) {
            specEl.textContent = `ISO/IEC 18004 · Version ${qr.version} (${qr.size}×${qr.size}) · EC-${qr.ecLevel} · ${node.rawUri.length} B`;
          }
        } catch (err) {
          if (specEl) specEl.textContent = err.message || 'Could not encode QR';
        }
      }
    } else {
      updateScannerDom();
      const stageCanvas = root.querySelector('[data-ref="scanCanvas"]');
      const stageBox = root.querySelector('[data-ref="scanStage"]');
      const fileInput = root.querySelector('[data-ref="fileInput"]');
      if (stageCanvas) bindCanvasCrop(stageCanvas);

      if (stageBox) {
        stageBox.addEventListener('dragover', (e) => {
          e.preventDefault();
          stageBox.classList.add('is-dragover');
        });
        stageBox.addEventListener('dragleave', () => {
          stageBox.classList.remove('is-dragover');
        });
        stageBox.addEventListener('drop', (e) => {
          e.preventDefault();
          stageBox.classList.remove('is-dragover');
          const file = e.dataTransfer?.files?.[0];
          if (file && file.type.startsWith('image/')) {
            const url = URL.createObjectURL(file);
            loadDataUrlIntoScanner(url, file.name).finally(() => URL.revokeObjectURL(url));
          }
        });
      }

      if (fileInput) {
        fileInput.addEventListener('change', () => {
          const file = fileInput.files?.[0];
          if (file) {
            const url = URL.createObjectURL(file);
            loadDataUrlIntoScanner(url, file.name).finally(() => URL.revokeObjectURL(url));
          }
        });
      }
    }

    const modalEl = root.querySelector('.modal');
    modalEl.onclick = async (e) => {
      if (e.target.hasAttribute('data-close') || e.target.closest('button[data-close]')) {
        close();
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;

      switch (btn.dataset.act) {
        case 'tab':
          activeTab = btn.dataset.tab;
          render();
          break;
        case 'qr-style':
          qrStyle = btn.dataset.style;
          render();
          break;
        case 'toggle-logo':
          showLogo = !showLogo;
          render();
          break;
        case 'prev-server':
          cycleServer(-1);
          break;
        case 'next-server':
          cycleServer(1);
          break;
        case 'edit-current': {
          const n = currentNode();
          if (n && onEditServer) {
            close();
            onEditServer(n.id, () => {
              openQrModal({
                initialTab: 'share',
                serverId: n.id,
                store,
                api,
                onEditServer,
                onImported,
              });
            });
          }
          break;
        }
        case 'copy-qr-uri': {
          const n = currentNode();
          if (n) copyText(n.rawUri, 'Share link copied');
          break;
        }
        case 'copy-qr-img': {
          const n = currentNode();
          if (!n) break;
          try {
            const card = buildShareCardCanvas(n, qrStyle, showLogo);
            const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toast('QR card image copied to clipboard', 'success');
          } catch {
            toast('Could not copy image to clipboard — use Save PNG Card instead', 'error');
          }
          break;
        }
        case 'save-qr-png': {
          const n = currentNode();
          if (!n) break;
          const card = buildShareCardCanvas(n, qrStyle, showLogo);
          const a = document.createElement('a');
          const safeName = n.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'xray-server';
          a.download = `${safeName}-qr.png`;
          a.href = card.toDataURL('image/png');
          a.click();
          toast('Saved QR PNG card', 'success');
          break;
        }
        case 'reset-scan':
          previewResult = null;
          scanStatus = 'Ready to scan';
          scanSub = 'Choose a capture source on the left or press Ctrl+V to paste a QR image';
          scanTone = 'neutral';
          render();
          break;
        case 'scan-clipboard':
          await scanFromClipboard();
          break;
        case 'scan-screen':
          await scanFromScreen();
          break;
        case 'scan-file':
          root.querySelector('[data-ref="fileInput"]')?.click();
          break;
        case 'scan-camera':
          await toggleCamera();
          break;
        case 'copy-decoded':
          if (previewResult?.rawText) copyText(previewResult.rawText, 'Decoded QR text copied');
          break;
        case 'confirm-import': {
          if (!previewResult?.rawText) break;
          const res = await api('/api/import-links', { rawText: previewResult.rawText });
          if (res.importedCount > 0) {
            toast(`Imported ${res.importedCount} server${res.importedCount === 1 ? '' : 's'} from QR code`, 'success');
            close();
            onImported?.();
          } else {
            toast(res.errors?.[0] || 'Could not import server', 'error');
          }
          break;
        }
        case 'confirm-import-edit': {
          if (!previewResult?.rawText) break;
          const beforeIds = new Set((store.data.servers || []).map((s) => s.id));
          const res = await api('/api/import-links', { rawText: previewResult.rawText });
          if (res.importedCount > 0) {
            toast('Server imported from QR — opening editor', 'success');
            close();
            setTimeout(() => {
              const added =
                (store.data.servers || []).find((s) => !beforeIds.has(s.id)) ||
                store.data.servers?.[store.data.servers.length - 1];
              if (added && onEditServer) onEditServer(added.id);
            }, 120);
          } else {
            toast(res.errors?.[0] || 'Could not import server', 'error');
          }
          break;
        }
        case 'confirm-sub': {
          if (!previewResult?.url) break;
          btn.disabled = true;
          const res = await api('/api/add-subscription', { url: previewResult.url, name: 'QR Subscription' });
          btn.disabled = false;
          if (res.ok) {
            toast(`Subscription added (${res.count} servers)`, 'success');
            close();
            onImported?.();
          } else {
            toast(res.error || 'Could not add subscription', 'error');
          }
          break;
        }
      }
    };
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('paste', onGlobalPaste);
  render();
}
