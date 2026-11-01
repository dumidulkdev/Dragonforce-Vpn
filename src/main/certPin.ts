import tls from 'node:tls';
import crypto from 'node:crypto';

/**
 * Connects to a TLS server without verifying it and returns the SHA-256 of the
 * leaf certificate (hex), the format Xray expects in `pinnedPeerCertSha256`.
 *
 * Used for the "Allow insecure certificate" option: Xray ≥ 26 removed
 * `allowInsecure`, so we trust-on-connect by pinning the presented certificate.
 */
export function fetchLeafCertSha256(host: string, port: number, servername?: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: servername && !/^[\d.:]+$/.test(servername) ? servername : undefined,
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out reading the TLS certificate from ${host}:${port}`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate(false);
      socket.end();
      if (!cert?.raw) {
        reject(new Error(`${host}:${port} did not present a TLS certificate`));
        return;
      }
      resolve(crypto.createHash('sha256').update(cert.raw).digest('hex'));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not read the TLS certificate from ${host}:${port}: ${err.message}`));
    });
  });
}
