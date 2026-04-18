import { mkdirSync, existsSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Append-only NDJSON operations log for the pipeline.
 *
 * One file per day: ops/events-YYYY-MM-DD.ndjson. One JSON object per line
 * of shape: {"ts":"ISO-8601","event":"<name>","data":{...}}.
 *
 * Rotated transparently at midnight (UTC). Failures are swallowed so the
 * pipeline never goes down because of logging.
 */
export class EventLogger {
  constructor({ dir } = {}) {
    this.dir = dir || resolve(__dirname, '..', 'ops');
    this.currentDate = null;
    this.stream = null;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    } catch { /* ignore */ }
  }

  _openFor(dateStr) {
    try {
      if (this.stream) this.stream.end();
    } catch { /* ignore */ }
    try {
      const path = resolve(this.dir, `events-${dateStr}.ndjson`);
      this.stream = createWriteStream(path, { flags: 'a' });
      // Swallow stream errors — logging must never crash the pipeline.
      this.stream.on('error', () => { this.stream = null; });
      this.currentDate = dateStr;
    } catch {
      this.stream = null;
    }
  }

  write(event, data) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    if (dateStr !== this.currentDate) this._openFor(dateStr);
    if (!this.stream) return;
    try {
      const line = JSON.stringify({ ts: now.toISOString(), event, data: data || {} }) + '\n';
      this.stream.write(line);
    } catch { /* logging must never throw */ }
  }

  close() {
    try { this.stream?.end(); } catch { /* ignore */ }
    this.stream = null;
  }

  /**
   * Read events for a date range. Used by /api/reports/events.
   * @param {Object} opts - {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', filter?: (e)=>bool, limit?: number}
   */
  async readRange({ from, to, filter, limit = 5000 } = {}) {
    const { readFile, readdir } = await import('fs/promises');
    const out = [];
    let files;
    try {
      files = (await readdir(this.dir))
        .filter((f) => f.startsWith('events-') && f.endsWith('.ndjson'))
        .sort();
    } catch {
      return out;
    }
    if (from) files = files.filter((f) => f.slice(7, 17) >= from);
    if (to) files = files.filter((f) => f.slice(7, 17) <= to);

    for (const f of files) {
      let raw;
      try {
        raw = await readFile(resolve(this.dir, f), 'utf-8');
      } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (filter && !filter(entry)) continue;
        out.push(entry);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

