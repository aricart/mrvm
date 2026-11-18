// published versions on jsr and npm.

import type { Module } from "./workspace.ts";

export interface Published {
  /** versions on jsr, or null when the module isn't on jsr */
  jsr: Set<string> | null;
  /** versions on npm, or null when the module isn't on npm */
  npm: Set<string> | null;
  /** lookups that failed (network, timeout) */
  errors: string[];
}

async function getJson(url: string, timeout: number): Promise<unknown | null> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { accept: "application/json" },
  });
  if (r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`${url}: ${r.status} ${r.statusText}`);
  }
  return await r.json();
}

/**
 * The published versions of a module, from its jsr and npm names.
 */
export async function published(
  m: Module,
  timeout = 10_000,
): Promise<Published> {
  const out: Published = { jsr: null, npm: null, errors: [] };
  const tasks: Promise<void>[] = [];
  if (m.jsr) {
    tasks.push(
      getJson(`https://jsr.io/${m.jsr}/meta.json`, timeout).then((j) => {
        const v = (j as { versions?: Record<string, unknown> } | null)?.versions;
        out.jsr = new Set(v ? Object.keys(v) : []);
      }).catch((err) => {
        out.errors.push(`jsr ${m.jsr}: ${(err as Error).message}`);
      }),
    );
  }
  if (m.npm) {
    const name = m.npm.replace("/", "%2f");
    tasks.push(
      getJson(`https://registry.npmjs.org/${name}`, timeout).then((j) => {
        const v = (j as { versions?: Record<string, unknown> } | null)?.versions;
        out.npm = new Set(v ? Object.keys(v) : []);
      }).catch((err) => {
        out.errors.push(`npm ${m.npm}: ${(err as Error).message}`);
      }),
    );
  }
  await Promise.all(tasks);
  return out;
}

/**
 * Runs `fn` over the items with at most `limit` at once, reporting each
 * finished item.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  done?: (item: T, n: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      done?.(items[i], ++finished);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
