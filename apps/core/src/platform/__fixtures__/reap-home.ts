import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessIdentity } from '../process-table.ts';
import { stopTree, type TreeStopDeps } from '../tree-stop.ts';

/**
 * Снятие отвязанных процессов ядра под одним каталогом — для тестов и сред прогона ядра (этап 10,
 * зона C, проход 6). Хост сессии и хост звеньев запускаются отвязанными, чтобы пережить перезапуск
 * ядра (P10, P123): ни конец теста, ни конец прогона их не уносят. Без снятия они жили днями и
 * держали свои каталоги (`vc-*\hop-crash-*`, `%ProgramData%\agentdeck-live\vl-*`, 02–03.11).
 *
 * Кого снимаем — только по записям, которые пишет само ядро ПОД этим каталогом, никогда по имени:
 * `host.json` (хост сессии и его CLI), каждый `procs.json` (строки `servers[]` — хост звеньев,
 * серверы заглушки; `cores[]` — ядро), строки `session.started` журналов задач. Снимается
 * личность (номер + старт): освободившийся номер мог достаться чужому процессу. Хост звеньев
 * человека (`~/.agentdeck/core`) сюда не попадает, пока каталог не его.
 */

/** Глубже записей ядра нет: `tasks/<задача>/sessions/<сессия>/base-probe/host.json` под домом в стенде. */
const DEPTH = 10;
const SKIP = new Set(['.git', 'node_modules']);

export interface ReapedIdentity extends ProcessIdentity {
  role: 'host' | 'cli' | 'hop-host' | 'server' | 'core';
  record: string;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/** Записи ядра под `root`: файлы `host.json`, `procs.json`, `journal.jsonl` (ссылки не обходятся). */
function recordsUnder(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > DEPTH) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) recordsUnder(path, depth + 1, out);
    } else if (
      entry.isFile() &&
      (entry.name === 'host.json' || entry.name === 'procs.json' || entry.name === 'journal.jsonl')
    ) {
      out.push(path);
    }
  }
  return out;
}

export function coreIdentitiesUnder(root: string): ReapedIdentity[] {
  const found = new Map<string, ReapedIdentity>();
  const add = (pid: unknown, start: unknown, role: ReapedIdentity['role'], record: string) => {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
    if (typeof start !== 'string' || start === '') return;
    found.set(`${pid}:${start}`, { pid, start, role, record });
  };
  for (const path of recordsUnder(root)) {
    if (path.endsWith('host.json')) {
      const record = readJson(path);
      add(field(field(record, 'host'), 'pid'), field(field(record, 'host'), 'start'), 'host', path);
      add(
        field(field(record, 'child'), 'pid'),
        field(field(record, 'child'), 'start'),
        'cli',
        path,
      );
    } else if (path.endsWith('procs.json')) {
      const procs = readJson(path);
      const servers = field(procs, 'servers');
      for (const row of Array.isArray(servers) ? servers : []) {
        const role = field(row, 'kind') === 'hop-host' ? 'hop-host' : 'server';
        add(field(row, 'pid'), field(row, 'pidStart'), role, path);
      }
      const cores = field(procs, 'cores');
      for (const row of Array.isArray(cores) ? cores : []) {
        add(field(row, 'pid'), field(row, 'pidStart'), 'core', path);
      }
    } else {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const raw of text.split('\n')) {
        if (!raw.includes('"session.started"')) continue;
        let line: unknown;
        try {
          line = JSON.parse(raw) as unknown;
        } catch {
          continue;
        }
        if (field(line, 'kind') !== 'session.started') continue;
        const data = field(line, 'data');
        add(field(data, 'hostPid'), field(data, 'hostStart'), 'host', path);
        add(field(data, 'cliPid'), field(data, 'cliStart'), 'cli', path);
      }
    }
  }
  return [...found.values()];
}

export interface ReapReport {
  found: ReapedIdentity[];
  /** Кто жив той же личностью после снятия (или чью остановку не удалось подтвердить). */
  residual: ProcessIdentity[];
  unknown?: string;
}

/**
 * Снять всё, что ядро записало под `root`, деревом (CLI хоста — потомок, его дети — тоже).
 * Ядро — первым: живое ядро подняло бы снятый хост заново.
 */
export async function reapCoreProcessesUnder(
  root: string,
  deps: TreeStopDeps = {},
): Promise<ReapReport> {
  const found = coreIdentitiesUnder(root);
  const order: ReapedIdentity['role'][] = ['core', 'host', 'hop-host', 'server', 'cli'];
  const sorted = [...found].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const residual: ProcessIdentity[] = [];
  const doubts: string[] = [];
  for (const id of sorted) {
    const report = await stopTree(
      { pid: id.pid, start: id.start },
      { graceMs: 1_000, killWaitMs: 2_000 },
      deps,
    );
    for (const left of report.residual)
      if (!residual.some((r) => r.pid === left.pid && r.start === left.start)) residual.push(left);
    if (report.unknown) doubts.push(`${id.role} ${id.pid}: ${report.unknown}`);
  }
  return { found, residual, ...(doubts.length > 0 ? { unknown: doubts.join('; ') } : {}) };
}
