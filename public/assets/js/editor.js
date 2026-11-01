import { icon } from './icons.js';
import { escapeHtml } from './ui.js';

const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'random', 'randomized'];
const CIPHERS = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'];
const NETWORKS = [
  ['tcp', 'TCP'],
  ['ws', 'WebSocket'],
  ['grpc', 'gRPC'],
  ['httpupgrade', 'HTTPUpgrade'],
  ['xhttp', 'XHTTP'],
];

const field = (label, name, value, { placeholder = '', type = 'text', mono = false, hint = '' } = {}) => `
  <label class="form-field" data-field="${name}">
    <span class="form-label">${label}</span>
    <span class="field"><input name="${name}" type="${type}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}"${mono ? ' class="mono"' : ''} autocomplete="off" spellcheck="false" /></span>
    ${hint ? `<span class="form-hint">${hint}</span>` : ''}
  </label>`;

const select = (label, name, value, options) => `
  <label class="form-field" data-field="${name}">
    <span class="form-label">${label}</span>
    <span class="field field-select"><select name="${name}">${options
      .map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`)
      .join('')}</select>${icon('chevronRight', 14, 'select-chevron')}</span>
  </label>`;

/**
 * Opens the server editor dialog. `onSave(patch)` must return a promise that
 * resolves to `{ ok, error? }`; the dialog stays open on error.
 */
export function openServerEditor(node, onSave, onShowQr) {
  const root = document.getElementById('modal-root');
  const isVless = node.protocol === 'vless';
  root.innerHTML = `
  <div class="modal" data-close>
    <form class="panel modal-box editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" novalidate>
      <div class="modal-head">
        <div><h3 id="editor-title">Edit server</h3><div class="form-hint">${node.protocol.toUpperCase()} · changes regenerate the share link</div></div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x', 16)}</button>
      </div>
      <div class="editor-body">
        <section class="form-section">
          <h4>General</h4>
          <div class="form-grid">
            <div class="span-2">${field('Remarks', 'name', node.name, { placeholder: 'Display name' })}</div>
            ${field('Address', 'address', node.address, { placeholder: 'server.example.com', mono: true })}
            ${field('Port', 'port', node.port, { type: 'number', mono: true })}
            <div class="span-2">${field('UUID', 'uuid', node.uuid, { mono: true })}</div>
          </div>
        </section>

        <section class="form-section">
          <h4>Transport</h4>
          <div class="form-grid">
            ${select('Network', 'network', node.network, NETWORKS)}
            ${select('Header type', 'headerType', node.headerType || 'none', [['none', 'None'], ['http', 'HTTP obfuscation']])}
            ${field('Host', 'host', node.host, { placeholder: 'Host header / domain', mono: true })}
            ${field('Path', 'path', node.path, { placeholder: '/', mono: true })}
          </div>
        </section>

        <section class="form-section">
          <h4>Security</h4>
          <div class="form-grid">
            ${select('Security', 'security', node.security, [['tls', 'TLS'], ['reality', 'Reality'], ['none', 'None']])}
            ${select('Fingerprint', 'fingerprint', node.fingerprint || 'chrome', FINGERPRINTS.map((f) => [f, f[0].toUpperCase() + f.slice(1)]))}
            ${field('SNI', 'sni', node.sni, { placeholder: 'Server name indication', mono: true })}
            ${field('ALPN', 'alpn', (node.alpn || []).join(','), { placeholder: 'h2,http/1.1', mono: true })}
            ${field('Public key', 'publicKey', node.publicKey, { mono: true })}
            ${field('Short ID', 'shortId', node.shortId, { mono: true })}
            ${field('SpiderX', 'spiderX', node.spiderX, { placeholder: '/', mono: true })}
            <div class="form-field form-toggle span-2" data-field="allowInsecure">
              <span><span class="form-label">Allow insecure certificate</span><span class="form-hint">For legacy 3x-ui servers requiring allowInsecure=true, including self-signed or mismatched certificates. Trusts and pins the certificate presented at each connection.</span></span>
              <button type="button" class="switch" role="switch" name="allowInsecure" aria-checked="${!!node.allowInsecure}" aria-label="Allow insecure certificate"></button>
            </div>
          </div>
        </section>

        <section class="form-section">
          <h4>${isVless ? 'VLESS' : 'VMess'}</h4>
          <div class="form-grid">
            ${isVless
              ? `${select('Flow', 'flow', node.flow || '', [['', 'None'], ['xtls-rprx-vision', 'xtls-rprx-vision']])}
                 ${field('Encryption', 'encryption', node.encryption || 'none', { mono: true })}`
              : `${field('Alter ID', 'alterId', node.alterId ?? 0, { type: 'number', mono: true })}
                 ${select('Cipher', 'cipher', node.cipher || 'auto', CIPHERS.map((c) => [c, c]))}`}
          </div>
        </section>
      </div>
      <div class="modal-foot">
        <p class="form-error" data-ref="error" role="alert"></p>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn" data-ref="saveQr" title="Save changes and display a scannable QR code">${icon('qr', 15)}Save & Show QR</button>
        <button type="submit" class="btn btn-primary" data-ref="save">${icon('check', 16)}Save changes</button>
      </div>
    </form>
  </div>`;

  const form = root.querySelector('form');
  const errorEl = form.querySelector('[data-ref="error"]');
  const saveBtn = form.querySelector('[data-ref="save"]');
  const saveQrBtn = form.querySelector('[data-ref="saveQr"]');
  const insecure = form.querySelector('[name="allowInsecure"]');
  const val = (n) => form.elements[n]?.value ?? '';
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  /** Show only fields that apply to the chosen transport/security. */
  function syncVisibility() {
    const net = val('network');
    const sec = val('security');
    const show = (name, on) => {
      const el = form.querySelector(`[data-field="${name}"]`);
      if (el) el.hidden = !on;
    };
    show('headerType', net === 'tcp');
    show('host', net !== 'grpc');
    show('path', net !== 'tcp' || val('headerType') === 'http');
    form.querySelector('[data-field="path"] .form-label').textContent = net === 'grpc' ? 'Service name' : 'Path';
    show('sni', sec !== 'none');
    show('fingerprint', sec !== 'none');
    show('alpn', sec === 'tls');
    show('allowInsecure', sec === 'tls');
    for (const n of ['publicKey', 'shortId', 'spiderX']) show(n, sec === 'reality');
  }
  syncVisibility();
  form.addEventListener('change', syncVisibility);

  insecure.addEventListener('click', () => {
    insecure.setAttribute('aria-checked', String(insecure.getAttribute('aria-checked') !== 'true'));
  });

  root.querySelector('.modal').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close') || e.target.closest('button[data-close]')) close();
  });

  async function submitForm(showQrAfter = false) {
    errorEl.textContent = '';
    const patch = {
      name: val('name'),
      address: val('address'),
      port: val('port'),
      uuid: val('uuid'),
      network: val('network'),
      headerType: val('network') === 'tcp' ? val('headerType') : 'none',
      host: val('host'),
      path: val('path'),
      security: val('security'),
      fingerprint: val('fingerprint'),
      sni: val('sni'),
      alpn: val('alpn'),
      publicKey: val('publicKey'),
      shortId: val('shortId'),
      spiderX: val('spiderX'),
      allowInsecure: insecure.getAttribute('aria-checked') === 'true',
    };
    if (isVless) Object.assign(patch, { flow: val('flow'), encryption: val('encryption') });
    else Object.assign(patch, { alterId: val('alterId'), cipher: val('cipher') });

    saveBtn.disabled = true;
    if (saveQrBtn) saveQrBtn.disabled = true;
    try {
      const res = await onSave(patch);
      if (res?.ok) {
        close();
        if (showQrAfter && onShowQr) onShowQr();
      } else {
        errorEl.textContent = res?.error || 'Could not save changes';
      }
    } finally {
      saveBtn.disabled = false;
      if (saveQrBtn) saveQrBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm(false);
  });
  saveQrBtn?.addEventListener('click', () => submitForm(true));

  form.elements.name.focus();
  form.elements.name.select();
}
