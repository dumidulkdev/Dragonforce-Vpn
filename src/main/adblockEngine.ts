import fs from 'node:fs';
import type { AdBlockState } from '../../packages/core/src/types.ts';
import { parseAdBlockAccessLogChunk } from '../../packages/core/src/adblockEngine.ts';

export * from '../../packages/core/src/adblockEngine.ts';

/**
 * Incrementally tails Xray's access.log to capture every request routed to `[... -> adblock]`.
 */
export class AdBlockLogWatcher {
  private lastOffset = 0;

  public reset(): void {
    this.lastOffset = 0;
  }

  public poll(accessLogPath: string, state: AdBlockState): number {
    if (!state.config.enabled || !fs.existsSync(accessLogPath)) return 0;

    try {
      const stat = fs.statSync(accessLogPath);
      if (stat.size < this.lastOffset) {
        this.lastOffset = 0;
      }
      if (stat.size === this.lastOffset) return 0;

      const fd = fs.openSync(accessLogPath, 'r');
      const len = stat.size - this.lastOffset;
      const buf = Buffer.alloc(Math.min(len, 256 * 1024));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, this.lastOffset);
      fs.closeSync(fd);

      this.lastOffset += bytesRead;

      // Rotate/truncate access log if it grows > 512 KB so disk usage stays tiny
      if (this.lastOffset > 512 * 1024) {
        try {
          fs.truncateSync(accessLogPath, 0);
          this.lastOffset = 0;
        } catch {
          // ignore
        }
      }

      const text = buf.subarray(0, bytesRead).toString('utf-8');
      return parseAdBlockAccessLogChunk(text, state);
    } catch {
      return 0;
    }
  }
}
