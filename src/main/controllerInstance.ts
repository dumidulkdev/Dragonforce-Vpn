import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** Ask the owning controller to restore networking, then wait for it to release its port. */
export async function stopPreviousController(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/init`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Port ${port} is used by another application`);
  const initial = await response.json() as Record<string, any>;
  const legacyController = initial.status?.binariesReady && Array.isArray(initial.data?.servers) && initial.terminalCommands?.powershell?.includes('HTTP_PROXY');
  if (initial.appId !== 'dragonforce-vpn' && !legacyController) throw new Error(`Port ${port} is used by another application`);
  const shutdown = await fetch(`${base}/api/shutdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(initial.apiToken ? { 'X-DragonForce-Token': initial.apiToken } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const result = await shutdown.json() as { ok?: boolean; error?: string };
  if (!shutdown.ok || !result.ok) throw new Error(result.error || 'Previous controller could not restore networking');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const finish = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(500, () => finish(true));
    });
    if (!listening) return;
    await delay(100);
  }
  throw new Error('Previous controller has not released its port after cleanup');
}
