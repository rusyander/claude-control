import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { JOURNAL_DATA_V1 } from '@agentdeck/contracts/core/journal';
import type {
  CheckEntry,
  CheckRegistry,
  CheckRequest,
  QuarantineEntry,
  TreeRow,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { JournalInputError } from '../../../journal/journal.types.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { createLivenessProbe, identityOfPid } from '../../../platform/process-identity.ts';
import {
  fixtureEntry,
  fixtureRegistry,
  fixtureRows,
} from '../../../verifier/__fixtures__/registry.ts';
import { keyOf } from '../../../verifier/key/index.ts';
import { createCheckQueue, type CheckQueue } from '../../../verifier/queue/queue.ts';
import { createRecordStore, type RecordStore } from '../../../verifier/store/index.ts';
import type { CheckDeps, CheckJournalEntry } from '../checks.types.ts';
import { createCheckService, type CheckService } from '../request.ts';

/**
 * Стенд входа проверки: настоящие очередь (каталог в temp), хранилище записей, судья, раннер и
 * дочерний node-процесс проверки. Подменена только внешняя граница: строки дерева git (ключ
 * считается настоящим `keyOf` по ним) и пин окружения. Журнал собирается и сверяется со схемой
 * журнала — строка, которую схема не примет, видна в `badLines`.
 */

export const CHECK_SCRIPT = fileURLToPath(new URL('./check.mjs', import.meta.url));

export function checkEntry(over: Partial<CheckEntry> = {}): CheckEntry {
  return fixtureEntry({
    argv: [process.execPath, CHECK_SCRIPT, '{units}'],
    filter: {
      kind: 'vitest',
      argv: [process.execPath, CHECK_SCRIPT, '{units}', '--tests', '{tests}'],
    },
    envAllow: [],
    tools: [],
    ...over,
  });
}

export function checkRegistry(): CheckRegistry {
  return fixtureRegistry({
    checks: [
      checkEntry(),
      checkEntry({
        id: 'lint',
        class: 'static',
        argv: [process.execPath, CHECK_SCRIPT, '{units}', '--lint'],
        filter: undefined,
      }),
      checkEntry({
        id: 'whole',
        class: 'static',
        unit: 'project',
        argv: [process.execPath, CHECK_SCRIPT, '{units}', '--whole'],
        filter: undefined,
        requiredAt: [],
      }),
    ],
  });
}

export interface HarnessOptions {
  /** Сдвиг часов входа проверки (очередь живёт по настоящим) — для срока ожидания. */
  shiftMs?: number;
  answerBudgetMs?: number;
  slots?: number;
  registry?: Fact<CheckRegistry>;
  env?: 'unknown';
  blockers?: Unmet[];
  /**
   * Журнал задачи отклоняет строку так же, как настоящий писатель (`JournalInputError`): ответ
   * не `null` — текст отказа. Строка, что не прошла схему, отклоняется всегда.
   */
  journalRefuses?: (entry: CheckJournalEntry) => string | null;
}

export interface Harness {
  dir: string;
  service: CheckService;
  queue: CheckQueue;
  store: RecordStore;
  journal: (CheckJournalEntry & { taskId: string })[];
  badLines: string[];
  /** Потерянные строки журнала, названные входом (`onJournalLoss`). */
  losses: string[];
  quarantine: QuarantineEntry[];
  tempRoot: string;
  mode(mode: 'pass' | 'fail' | 'flaky' | 'slow' | 'loud', slowMs?: number): void;
  edit(rows: Record<string, Partial<TreeRow>>): void;
  spawns(): string[][];
  req(over?: Partial<CheckRequest>): CheckRequest;
  keyFor(checkId: string, unit: string, selection?: string[]): string;
  close(): void;
}

export const TASK = '0192f000-0000-7000-8000-0000000000aa';

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'adk-checks-'));
  const copyDir = join(dir, 'copy');
  mkdirSync(copyDir, { recursive: true });
  const counter = join(dir, 'spawns.log');
  const tempRoot = join(dir, 'tmp');
  const me = await identityOfPid(process.pid);
  if (!('value' in me)) throw new Error('own identity unreadable');
  const probe = createLivenessProbe();
  const queue = createCheckQueue({
    dir: join(dir, 'queue'),
    config: () => ({ slots: options.slots ?? 2, shareCap: 1, agingMs: 60_000, beatMs: 100 }),
    holder: { pid: process.pid, start: me.value.start, bootId: 'harness' },
    build: 'b1',
    now: Date.now,
    newId,
    isAlive: (id) => probe.isAlive(id),
  });
  const store = createRecordStore({ root: join(dir, 'store'), key: randomBytes(32) });
  const registry = options.registry ?? { value: checkRegistry() };
  let rows = fixtureRows();
  let env: Record<string, string> = {};
  const basics: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir']) {
    const value = process.env[name];
    if (value !== undefined) basics[name] = value;
  }
  const journal: Harness['journal'] = [];
  const badLines: string[] = [];
  const losses: string[] = [];
  const quarantine: QuarantineEntry[] = [];
  const reg = (): CheckRegistry => ('value' in registry ? registry.value : checkRegistry());
  const keyOfUnit = (entry: CheckEntry, unit: string, selection: string[], r: CheckRegistry) =>
    keyOf(entry, unit, {
      registry: r,
      rows: { value: rows },
      baseRows: null,
      selection,
      inputs: { value: {} },
      tools: {},
      env: {},
      envDigest: (v) => v,
    });
  const deps: CheckDeps = {
    queue,
    store: () => ({ value: store }),
    registry: async () => registry,
    key: async ({ entry, registry: r, unit, selection }) => keyOfUnit(entry, unit, selection, r),
    env: async () =>
      options.env === 'unknown'
        ? { unknown: 'pin not resolved' }
        : { value: { ...basics, CHECK_COUNTER: counter, ...env } },
    standEpoch: () => null,
    journal: (taskId, entry) => {
      const parsed = JOURNAL_DATA_V1[entry.kind].safeParse(entry.data);
      if (!parsed.success) {
        badLines.push(`${entry.kind}: ${parsed.error.message}`);
        throw new JournalInputError([`${entry.kind}: ${parsed.error.message}`]);
      }
      const refused = options.journalRefuses?.(entry) ?? null;
      if (refused !== null) throw new JournalInputError([refused]);
      journal.push({ taskId, ...entry });
    },
    onJournalLoss: (_taskId, kind, reason) => {
      losses.push(`${kind}: ${reason}`);
    },
    tempRoot,
    now: () => Date.now() + (options.shiftMs ?? 0),
    newId,
    quarantine: () => ({ value: [...quarantine] }),
    writeQuarantine: (_req, entries) => {
      quarantine.splice(0, quarantine.length, ...entries);
    },
    blockers: async () => options.blockers ?? [],
    pollMs: 50,
    ...(options.answerBudgetMs !== undefined ? { answerBudgetMs: options.answerBudgetMs } : {}),
  };
  const service = createCheckService(deps);
  return {
    dir,
    service,
    queue,
    store,
    journal,
    badLines,
    losses,
    quarantine,
    tempRoot,
    mode(mode, slowMs) {
      env = {
        CHECK_MODE: mode,
        ...(slowMs !== undefined ? { CHECK_SLOW_MS: String(slowMs) } : {}),
      };
    },
    edit(edit) {
      rows = fixtureRows(edit);
    },
    spawns() {
      try {
        return readFileSync(counter, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        // Файла нет — ни одного запуска.
        return [];
      }
    },
    req(over = {}) {
      return {
        road: 'conductor',
        origin: 'core',
        taskId: TASK,
        stepId: null,
        project: 'p',
        copyDir,
        class: 'work',
        phase: 'final',
        checkId: 'tests',
        unit: 'app',
        changedUnits: ['app'],
        exec: 'core',
        ...over,
      };
    },
    keyFor(checkId, unit, selection = []) {
      const r = reg();
      const entry = r.checks.find((c) => c.id === checkId);
      if (!entry) throw new Error(`no entry ${checkId}`);
      const k = keyOfUnit(entry, unit, selection, r);
      if (!('value' in k)) throw new Error('key unknown');
      return k.value.key;
    },
    close() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
