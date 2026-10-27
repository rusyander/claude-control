import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptsOf } from './ledger-checks.ts';
import {
  emptyCopyLedger,
  foldLedger,
  LEDGER_KEEP_MS,
  pruneCopyLedger,
  repoOf,
  type CopyLedger,
  type LedgerFeedEvent,
  type LedgerSnapshot,
} from './ledger-rules.ts';

/**
 * Читатель журнала проверок для R40/R41: `<home>/events.jsonl` дочитывается с места,
 * где остановился прошлый тик (файл растёт на сотни килобайт за день); на старте —
 * последние 2 МБ, с прежним `.1`, если нынешний файл только что начат. Сменился файл
 * (журнал ушёл в `.1`, размер меньше прочитанного) — читается заново с начала.
 */

/** Первое чтение: хвост, в котором с запасом лежат три часа событий. */
const FIRST_BYTES = 2 * 1024 * 1024;
const RECENT_CAP = 3000;

export interface LedgerSource {
  read(): LedgerSnapshot;
  /** Скрипты `package.json` каталога — раскрыть `pnpm test` до инструмента (R41). */
  scriptsOf: ScriptsOf;
}

function readRange(file: string, from: number, to: number): string {
  if (to <= from) return '';
  let fd: number | undefined;
  try {
    const buffer = Buffer.alloc(to - from);
    fd = openSync(file, 'r');
    const got = readSync(fd, buffer, 0, to - from, from);
    return buffer.subarray(0, got).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

function parseLines(text: string): LedgerFeedEvent[] {
  const out: LedgerFeedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as LedgerFeedEvent;
      if (typeof event.at === 'number' && typeof event.kind === 'string') out.push(event);
    } catch {
      /* строка, дописанная наполовину, — не событие */
    }
  }
  return out;
}

function createScriptsOf(): ScriptsOf {
  const cache = new Map<string, { stamp: string; scripts?: Record<string, string> }>();
  return (dir) => {
    const file = join(dir, 'package.json');
    let stamp: string;
    try {
      const stat = statSync(file);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
    const known = cache.get(file);
    if (known?.stamp === stamp) return known.scripts;
    let scripts: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        scripts = Object.fromEntries(
          Object.entries(parsed.scripts).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      scripts = undefined;
    }
    cache.set(file, { stamp, ...(scripts ? { scripts } : {}) });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return scripts;
  };
}

export function createLedgerFeed(home: string, now: () => number = Date.now): LedgerSource {
  const file = join(home, 'events.jsonl');
  const copies = new Map<string, CopyLedger>();
  const recent: Array<{ at: number; repo: string }> = [];
  let offset = -1;
  let since: number | undefined;
  /** Недописанная последняя строка прошлого чтения. */
  let rest = '';

  const take = (events: readonly LedgerFeedEvent[]): void => {
    for (const event of events) {
      const repo = repoOf(event);
      if (!repo) continue;
      if (since === undefined || event.at < since) since = event.at;
      let copy = copies.get(repo);
      if (!copy) {
        copy = emptyCopyLedger();
        copies.set(repo, copy);
      }
      foldLedger(copy, event);
      recent.push({ at: event.at, repo: event.repo ?? event.cwd ?? repo });
    }
    if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
  };

  const prune = (at: number): void => {
    for (const [repo, copy] of copies) {
      pruneCopyLedger(copy, at);
      if (copy.ats.length === 0 && copy.findings.length === 0 && copy.green.size === 0) {
        copies.delete(repo);
      }
    }
    const first = recent.findIndex((event) => at - event.at <= LEDGER_KEEP_MS);
    recent.splice(0, first < 0 ? recent.length : first);
  };

  const read = (): LedgerSnapshot => {
    const size = sizeOf(file);
    if (size < 0) return { copies, recent, ...(since !== undefined ? { since } : {}) };
    if (offset < 0 || size < offset) {
      // Первое чтение или файл сменился: хвост с начала строки, прежний файл — если нынешний мал.
      const from = Math.max(0, size - FIRST_BYTES);
      let text = readRange(file, from, size);
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
      if (offset < 0 && from === 0) {
        const old = `${file}.1`;
        const oldSize = sizeOf(old);
        if (oldSize > 0) {
          let head = readRange(old, Math.max(0, oldSize - (FIRST_BYTES - size)), oldSize);
          if (oldSize > FIRST_BYTES - size) head = head.slice(head.indexOf('\n') + 1);
          take(parseLines(head));
        }
      }
      rest = '';
      offset = size;
      const lines = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      rest = text.slice(lines.length);
      take(parseLines(lines));
    } else if (size > offset) {
      const text = rest + readRange(file, offset, size);
      offset = size;
      const cut = text.lastIndexOf('\n') + 1;
      rest = text.slice(cut);
      take(parseLines(text.slice(0, cut)));
    }
    prune(now());
    return { copies, recent, ...(since !== undefined ? { since } : {}) };
  };

  return { read, scriptsOf: createScriptsOf() };
}
