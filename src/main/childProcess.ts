import type { ChildProcess } from 'node:child_process';

/** Wait for actual process exit before reusing its ports or removing ownership. */
export async function stopChildProcess(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      proc.removeListener('exit', exited);
      proc.removeListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => finish();
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`Process ${proc.pid} did not exit during cleanup`)), timeoutMs);
    proc.once('exit', exited);
    proc.once('error', failed);
    try {
      if (!proc.killed && !proc.kill()) finish(new Error(`Could not stop process ${proc.pid}`));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
