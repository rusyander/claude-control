import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_WATCH_DEFAULTS, groupSignalsOf } from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { wireGroupWatch } from './group-watch-wiring.ts';

/**
 * Проводка сторожа для группы Codex (ревью W, 🟡 5): переписка — настоящая
 * codex 0.155 (`foreign/__fixtures__`), дом Codex (`CODEX_HOME`) и хранилище —
 * файлы во временном каталоге.
 *
 * - Первый ход: id сессии ещё не известен — сторож находит свежую переписку по
 *   `session_meta.cwd` копии группы, только в каталогах дат от начала хода.
 * - Продолжение: файл ищется по id сессии — хвост имени `-<id>.jsonl`, в любом
 *   каталоге дат (сессия живёт там, где родилась).
 *
 * Что сторож прочитал именно этот файл, видно по R3: в переписке два сжатия с
 * разницей в секунду — частое сжатие.
 */

const FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'domains',
  'chat',
  'token-ledger',
  'foreign',
  '__fixtures__',
  'codex-0.155-two-turns.jsonl',
);
const SESSION = '01a164eb-2056-7b00-88b1-746831d6fc3f';
const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class IdleRun implements RunLike {
  pid = 1;
  start(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

type Row = Record<string, unknown> & { timestamp: string; payload?: Record<string, unknown> };

/**
 * Строки переписки фикстуры, сдвинутые так, что `session_meta` записана на
 * `startMs` от T0, с проектом `cwd`. Инструкции в `session_meta` раздуты до
 * 300 КБ — больше прежнего предела чтения первой строки (256 КБ).
 */
function codexRows(cwd: string, startMs: number): Row[] {
  const rows = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  const first = Date.parse(rows[0]!.timestamp);
  for (const row of rows) row.timestamp = at(startMs + Date.parse(row.timestamp) - first);
  const meta = rows[0]!.payload!;
  meta.cwd = cwd;
  meta.base_instructions = { text: 'x'.repeat(300 * 1024) };
  return rows;
}

const text = (rows: readonly Row[]): string =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

function wire() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-codex-'));
  dirs.push(dir);
  const home = join(dir, 'codex-home');
  vi.stubEnv('CODEX_HOME', home);
  const copy = join(dir, 'copy-1');
  mkdirSync(copy);
  const store = new AppStore(dir);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: dir,
    createdAt: at(0),
    groups: [{ index: 1, title: 'g', status: 'started', path: copy }],
  } as unknown as SplitPlanRecord);
  const watcher = wireGroupWatch(new ChatRunRegistry(() => new IdleRun()), {
    settings: () => GROUP_WATCH_DEFAULTS,
    link: (chatId) =>
      chatId === 'codex:child' || chatId === SESSION
        ? { parentChatId: 'parent', groupIndex: 1, stage: 'work', createdAt: at(0) }
        : undefined,
    plan: (parent) => store.getSplitPlan(parent),
    plans: () => store.getSplitPlans(),
    signals: {
      get: (parent, index) => store.getGroupWatchSignals(parent, index),
      set: (parent, index, block) => store.putGroupWatchSignals(parent, index, block),
      all: () => store.getAllGroupWatchSignals(),
      save: () => store.saveGroupWatchSignals(),
    },
    asksOf: () => [],
    projectsDir: () => join(dir, 'projects'),
    heavyQueueDir: dir,
    appDataDir: dir,
  });
  /** Файл сессии в каталоге даты `day` (`ГГГГ/ММ/ДД`) дома Codex. */
  const rollout = (day: string, name: string, rows: readonly Row[], mtimeMs: number): string => {
    const folder = join(home, 'sessions', ...day.split('/'));
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, text(rows));
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
    return path;
  };
  const rules = () =>
    groupSignalsOf(store.getGroupWatchSignals('parent', 1)).map((signal) => signal.rule);
  return { watcher, copy, rollout, rules };
}

describe('wireGroupWatch (Codex)', () => {
  it('first turn: the placeholder finds the fresh rollout of the copy, an old date folder is not walked', () => {
    vi.useFakeTimers({ now: T0 });
    const { watcher, copy, rollout, rules } = wire();
    // Ловушка: та же копия, «родилась» после старта и тронута позже всех — но в
    // каталоге даты на три недели раньше хода. Обход всей истории взял бы её
    // (самая свежая), и сжатий настоящей сессии сторож бы не увидел.
    const trap = codexRows(copy, 500).slice(0, 1);
    rollout('2026/10/01', 'rollout-2026-10-01T09-00-00-trap.jsonl', trap, T0 + 90_000);
    watcher.onFeed('codex:child', {
      kind: 'start',
      sessionId: 'codex:child',
      cwd: copy,
      detached: true,
      provider: 'codex',
    });
    rollout(
      '2026/10/20',
      `rollout-2026-10-20T10-00-01-${SESSION}.jsonl`,
      codexRows(copy, 1000),
      T0 + 60_000,
    );
    vi.setSystemTime(T0 + 60_000);
    watcher.tick();
    expect(rules()).toEqual(['R3']);
    watcher.stop();
  });

  it('first turn west of UTC: the folder carries the local date, a day before the UTC one — still found', () => {
    vi.useFakeTimers({ now: T0 });
    const { watcher, copy, rollout, rules } = wire();
    watcher.onFeed('codex:child', {
      kind: 'start',
      sessionId: 'codex:child',
      cwd: copy,
      detached: true,
      provider: 'codex',
    });
    // 10:00 UTC — ещё 19-е число в UTC−11: Codex кладёт файл в каталог 2026/10/19.
    rollout(
      '2026/10/19',
      `rollout-2026-10-19T23-00-01-${SESSION}.jsonl`,
      codexRows(copy, 1000),
      T0 + 60_000,
    );
    vi.setSystemTime(T0 + 60_000);
    watcher.tick();
    expect(rules()).toEqual(['R3']);
    watcher.stop();
  });

  it('resume: the real id finds its rollout by the `-<id>.jsonl` suffix in any date folder', () => {
    vi.useFakeTimers({ now: T0 + 60 * 60_000 });
    const { watcher, copy, rollout, rules } = wire();
    // Сессия родилась три недели назад; продолжение пишет в тот же файл.
    const rows = codexRows(copy, -21 * 24 * 60 * 60_000);
    const path = rollout(
      '2026/09/29',
      `rollout-2026-09-29T10-00-00-${SESSION}.jsonl`,
      rows.slice(0, 18),
      T0,
    );
    watcher.onFeed('codex:child', {
      kind: 'start',
      sessionId: SESSION,
      cwd: copy,
      detached: true,
      provider: 'codex',
    });
    // Ход продолжения: два сжатия подряд — прошлое файла сторож не догоняет, новое видит.
    const compacted = rows.find((row) => row.type === 'compacted')!;
    appendFileSync(
      path,
      text([
        { ...compacted, timestamp: at(60 * 60_000 + 1000) },
        { ...compacted, timestamp: at(60 * 60_000 + 2000) },
      ]),
    );
    vi.setSystemTime(T0 + 61 * 60_000);
    watcher.tick();
    expect(rules()).toEqual(['R3']);
    watcher.stop();
  });
});
