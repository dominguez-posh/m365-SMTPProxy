// Minimal JSON-file persistence (as in hrdnr). One file per collection in the data directory, written atomically.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STORES: { flush: () => void }[] = [];

export class Collection<T extends { id: string }> {
  private items = new Map<string, T>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    STORES.push({ flush: () => this.flush() });
    if (existsSync(file)) for (const x of JSON.parse(readFileSync(file, "utf8")) as T[]) this.items.set(x.id, x);
  }
  all() {
    return [...this.items.values()];
  }
  get(id: string) {
    return this.items.get(id);
  }
  find(fn: (x: T) => boolean) {
    for (const x of this.items.values()) if (fn(x)) return x;
    return undefined;
  }
  filter(fn: (x: T) => boolean) {
    return this.all().filter(fn);
  }
  put(x: T) {
    this.items.set(x.id, x);
    this.save();
    return x;
  }
  delete(id: string) {
    this.items.delete(id);
    this.save();
  }
  /** debounced atomic write */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
  }
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.all(), null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export class KeyValue<T extends object> {
  value: T;
  constructor(private file: string, initial: T) {
    STORES.push({ flush: () => this.save() });
    this.value = existsSync(file) ? { ...initial, ...JSON.parse(readFileSync(file, "utf8")) } : initial;
  }
  save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.value, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Append-only JSON-lines log per proxy (mail and service log). When a file grows beyond maxBytes, the older half
 * is dropped. Reading returns the newest entries first.
 */
export class LineLog {
  constructor(private dir: string, private maxBytes = 20 * 1024 * 1024) {
    mkdirSync(dir, { recursive: true });
  }
  private file(name: string) {
    return join(this.dir, name.replace(/[^\w.-]/g, "_") + ".jsonl");
  }
  append(name: string, entries: unknown[]) {
    if (!entries.length) return;
    const f = this.file(name);
    appendFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    if (statSync(f).size > this.maxBytes) {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
      writeFileSync(f + ".tmp", lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
      renameSync(f + ".tmp", f);
    }
  }
  read<T>(name: string, filter: (x: T) => boolean, limit: number): T[] {
    const f = this.file(name);
    if (!existsSync(f)) return [];
    const lines = readFileSync(f, "utf8").split("\n");
    const out: T[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const x = JSON.parse(lines[i]) as T;
        if (filter(x)) out.push(x);
      } catch {
        /* broken line */
      }
    }
    return out;
  }
  remove(name: string) {
    for (const f of [this.file(name)]) if (existsSync(f)) writeFileSync(f, "");
  }
}

export function openStore(dir: string) {
  mkdirSync(dir, { recursive: true });
  return { dir, f: (n: string) => join(dir, n + ".json") };
}
