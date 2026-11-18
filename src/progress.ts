// a one-line progress display for the slow steps (registry lookups, fetching
// tags). it writes to stderr, and only when stderr is a terminal, so piped
// output, --json and ci logs stay clean.

import process from "node:process";

export interface Progress {
  /** a step without a count, e.g. "fetching tags" */
  status(text: string): void;
  /** a step with a count, e.g. "registry 3/14 @nats-io/kv" */
  update(label: string, n: number, total: number, item?: string): void;
  /** clears the line */
  done(): void;
}

const quiet: Progress = { status() {}, update() {}, done() {} };

export function progress(enabled: boolean): Progress {
  if (!enabled || !process.stderr.isTTY) return quiet;
  let shown = false;
  const draw = (s: string) => {
    const width = process.stderr.columns || 80;
    process.stderr.write(`\r\x1b[2K${s.slice(0, width - 1)}`);
    shown = true;
  };
  return {
    status(text) {
      draw(`… ${text}`);
    },
    update(label, n, total, item) {
      const size = 20;
      const fill = Math.round((n / total) * size);
      const bar = "█".repeat(fill) + "░".repeat(size - fill);
      draw(`${label} [${bar}] ${n}/${total}${item ? ` ${item}` : ""}`);
    },
    done() {
      if (shown) process.stderr.write("\r\x1b[2K");
      shown = false;
    },
  };
}
