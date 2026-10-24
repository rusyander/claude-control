import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLedgerSink,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  ChatRun,
  type ChatEvent,
  type RunOptions,
} from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { LiveSessionPool } from '../../domains/chat/live-session/live-session.ts';
import type { RunLedgerEntry } from '../../domains/chat/run-ledger/run-ledger.ts';
import { keepWarmPath, readKeepWarm } from '../../domains/chat/keep-warm/keep-warm.ts';
import { wireKeepWarm } from './keep-warm-wiring.ts';

/**
 * Пинг после перезапуска панели (ревью keep-warm, R1): ход группы шёл в прошлой
 * жизни панели с вводной группы (`--append-system-prompt`), новая жизнь приняла
 * его из журнала прогонов — а журнал вводной не хранит. Пинг, собранный по
 * параметрам журнала, грел бы ДРУГОЙ префикс и переписывал окно. Путь настоящий:
 * два реестра над одним журналом, проводка с учётом на диске, процесс пинга —
 * настоящий `ChatRun`; подменены только процессы хода (реестр прошлой жизни) и
 * CLI пинга (`fake-live-cli.mjs` пишет свой argv в FAKE_ARGV_DUMP).
 */

const FAKE = fileURLToPath(
  new URL('../../domains/chat/__fixtures__/fake-live-cli.mjs', import.meta.url),
);
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const MIN = 60_000;
const T0 = Date.now() - 10 * MIN;

/** Ход группы прошлой жизни: сессия s1, ждёт (стоит на вопросе) до перезапуска. */
class TurnRun implements RunLike {
  pid = 4242;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    onEvent({ kind: 'session', sessionId: 's1' } as ChatEvent);
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

class FakeLedger implements RunLedgerSink {
  readonly entries = new Map<string, RunLedgerEntry>();
  read(): RunLedgerEntry[] {
    return [...this.entries.values()];
  }
  upsert(entry: RunLedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
  remove(key: string): void {
    this.entries.delete(key);
  }
}

let root: string;
let projects: string;
let appData: string;
let dump: string;
let pool: LiveSessionPool | undefined;

beforeAll(() => {
  if (process.platform !== 'win32') chmodSync(FAKE, 0o755);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kw-restart-'));
  projects = join(root, 'projects');
  appData = join(root, 'app');
  dump = join(root, 'argv.jsonl');
  mkdirSync(join(projects, 'work'), { recursive: true });
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(projects, 'work', 's1.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(T0).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'вопрос' }],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 119_990,
          cache_creation: { ephemeral_1h_input_tokens: 119_990 },
        },
      },
    }) + '\n',
    'utf8',
  );
  process.env.FAKE_ARGV_DUMP = dump;
});

afterEach(() => {
  delete process.env.FAKE_ARGV_DUMP;
  pool?.closeAll();
  pool = undefined;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
});

const plan = (): SplitPlanRecord =>
  ({
    parentChatId: 'parent',
    projectPath: root,
    createdAt: new Date(T0 - 60 * MIN).toISOString(),
    groups: [{ index: 1, title: 'g', status: 'awaiting', waitingFor: 'question', chatId: 'g1' }],
  }) as unknown as SplitPlanRecord;

function wiring(registry: ChatRunRegistry, now: number) {
  return wireKeepWarm(registry, {
    economy: () => GROUP_ECONOMY_DEFAULTS,
    coldContextTokens: () => 85_000,
    plans: () => ({ parent: plan() }),
    asksOf: () => [],
    projectsDir: () => projects,
    heavyQueueDir: join(root, 'heavy'),
    appDataDir: appData,
    now: () => now,
  });
}

/** Прошлая жизнь: ход группы с вводной; `tick` — проводка успела его увидеть. */
async function firstLife(ledger: FakeLedger, tick: boolean): Promise<void> {
  const registry = new ChatRunRegistry(() => new TurnRun());
  registry.setLedger(ledger, undefined, async (pid) => pid);
  registry.start(
    'g1',
    {
      prompt: 'работа',
      cwd: root,
      command: COMMAND,
      sessionId: 's1',
      appendSystemPrompt: 'вводная группы',
    },
    { origin: 'chat' },
  );
  if (tick) await wiring(registry, T0 + 10 * MIN).tick();
}

/**
 * Новая жизнь: ждущая живая сессия группы (процесс за посредником стоит на
 * вопросе) подхвачена из журнала — `adopt` записи `idle` с посредником. Сам
 * посредник не нужен: пинг — ответвление, своим процессом (настоящий `ChatRun`).
 */
function secondLife(ledger: FakeLedger): ChatRunRegistry {
  pool = new LiveSessionPool();
  const live = pool;
  const registry = new ChatRunRegistry(() => new ChatRun(live));
  registry.setLedger(ledger, undefined, async (pid) => pid);
  const entry = ledger.read()[0];
  if (!entry) throw new Error('журнал пуст');
  const idle: RunLedgerEntry = {
    ...entry,
    idle: true,
    relay: { pipe: join(root, 'gone.sock'), pid: 4242, signature: 'turn' },
  };
  expect(registry.adopt(idle, { isAlive: () => true, kill: () => undefined })).toBe(true);
  expect(registry.latestRunOf(['g1'])).toMatchObject({ sessionId: 's1', adopted: true });
  // Журнал прогонов вводной не хранит — вот почему пинг не собирается из него.
  expect(registry.latestRunOf(['g1'])?.options.appendSystemPrompt).toBeUndefined();
  return registry;
}

const argvs = (): string[][] =>
  existsSync(dump)
    ? readFileSync(dump, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];

describe('пинг после перезапуска панели', { timeout: 30_000 }, () => {
  it('ход принят из журнала — пинг идёт по шаблону учёта и несёт вводную группы', async () => {
    const ledger = new FakeLedger();
    await firstLife(ledger, true);
    expect(readKeepWarm(keepWarmPath(appData)).sessions.s1?.template).toMatchObject({
      appendSystemPrompt: 'вводная группы',
    });
    const registry = secondLife(ledger);
    await wiring(registry, T0 + 50 * MIN).tick();
    const pings = argvs();
    expect(pings).toHaveLength(1);
    expect(pings[0]?.join(' ')).toMatch(/--append-system-prompt/);
    expect(pings[0]).toEqual(
      expect.arrayContaining(['--fork-session', '--no-session-persistence']),
    );
    // Шаблон учёта не перезаписан урезанными параметрами журнала.
    expect(readKeepWarm(keepWarmPath(appData)).sessions.s1?.template).toMatchObject({
      appendSystemPrompt: 'вводная группы',
    });
  });

  it('шаблона нет (проводка хода не видела) — пинга нет, CLI не поднимается', async () => {
    const ledger = new FakeLedger();
    await firstLife(ledger, false);
    const registry = secondLife(ledger);
    await wiring(registry, T0 + 50 * MIN).tick();
    expect(argvs()).toEqual([]);
  });
});
