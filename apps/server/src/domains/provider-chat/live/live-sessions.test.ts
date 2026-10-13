import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerTurn } from './codex-app-server.ts';
import { GooseAcpTurn } from './goose-acp.ts';
import { KimiServerTurn } from './kimi-server.ts';
import { QwenServeTurn } from './qwen-serve.ts';
import type { LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * @covers live/{codex-app-server,goose-acp,kimi-server,qwen-serve}.ts — сессия между ходами (E2b)
 * @scenario ход оставляет сессию и отдаёт её id; следующий ход продолжает её
 *   другим процессом и шлёт только новое; пропавшая сессия сменяется новой с
 *   полным промптом; сменённая и упавшая удаляются; без `session` всё как раньше.
 *
 * Подделки CLI — настоящие дочерние процессы с тем же протоколом, что в
 * `live-turns.test.ts`; «диск» CLI — файл FAKE_STORE, который каждая подделка
 * читает заново, как настоящий CLI читает свой дом.
 */

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function spawnInto(file: string): LiveTurnOptions['spawnImpl'] {
  return ((_command: string, args: string[], options: object) =>
    spawn(
      process.execPath,
      [fixture(file), ...args],
      options,
    )) as unknown as LiveTurnOptions['spawnImpl'];
}

interface Cli {
  readonly name: string;
  readonly file: string;
  readonly prefix: string;
  readonly make: () => LiveTurn;
  readonly env: Record<string, string>;
  readonly failEnv: Record<string, string>;
  /** Одноразовую сессию CLI удаляет по концу хода (у qwen её уносит процесс). */
  readonly deletesOneOff: boolean;
}

const CLIS: Cli[] = [
  {
    name: 'codex',
    file: 'fake-codex-app-server.mjs',
    prefix: 'thr',
    make: () => new CodexAppServerTurn(),
    env: { FAKE_MODE: 'ok', HOLD_MS: '30' },
    failEnv: { FAKE_MODE: 'fail' },
    deletesOneOff: false,
  },
  {
    name: 'goose',
    file: 'fake-goose-acp.mjs',
    prefix: 'ses',
    make: () => new GooseAcpTurn(),
    env: { FAKE_MODE: 'ok', HOLD_MS: '30' },
    failEnv: { FAKE_MODE: 'fail' },
    deletesOneOff: true,
  },
  {
    name: 'kimi',
    file: 'fake-kimi-server.mjs',
    prefix: 'ses',
    make: () => new KimiServerTurn({ pollMs: 20 }),
    env: { FAKE_MODE: 'ok', HOLD_MS: '30' },
    failEnv: { FAKE_MODE: 'fail' },
    deletesOneOff: true,
  },
  {
    name: 'qwen',
    file: 'fake-qwen-serve.mjs',
    prefix: 'ses',
    make: () => new QwenServeTurn({ mcpWaitMs: 0 }),
    env: { FAKE_MODE: 'inject', HOLD_MS: '30', MCP_MS: '0' },
    failEnv: { FAKE_MODE: 'fail', MCP_MS: '0' },
    deletesOneOff: false,
  },
];

interface Disk {
  sessions: Record<string, { prompts: string[]; ephemeral?: boolean }>;
  deleted: string[];
  log: string[];
}

const FULL = 'вопрос человека';
const DELTA = 'только новое';

describe.each(CLIS)('$name: сессия между ходами разговора', (cli) => {
  let dir: string;
  let store: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `cc-live-session-${cli.name}-`));
    store = join(dir, 'store.json');
  });
  // Сервер-заглушка стоит в каталоге и под нагрузкой полного прогона гаснет дольше
  // секунды после конца хода (Windows держит cwd живого процесса) — ждём до 4 с.
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });

  const disk = (): Disk =>
    existsSync(store)
      ? (JSON.parse(readFileSync(store, 'utf8')) as Disk)
      : { sessions: {}, deleted: [], log: [] };

  const turn = (
    extra: Partial<LiveTurnOptions> = {},
    env: Record<string, string> = cli.env,
  ): Promise<LiveTurnResult> =>
    cli.make().run(
      {
        command: process.execPath,
        prompt: FULL,
        timeoutMs: 15_000,
        workdir: dir,
        env: { ...env, FAKE_STORE: store },
        spawnImpl: spawnInto(cli.file),
        ...extra,
      },
      () => {},
    );

  const id = (n: number): string => `${cli.prefix}-${n}`;

  it('ход с session оставляет сессию и отдаёт её id', async () => {
    const result = await turn({ session: {} });

    expect(result).toMatchObject({ kind: 'done', session: id(1), resumed: false });
    expect(disk().sessions[id(1)]?.prompts).toEqual([FULL]);
    expect(disk().deleted).toEqual([]);
  });

  it('следующий ход продолжает сессию другим процессом и шлёт только новое', async () => {
    await turn({ session: {} });
    const result = await turn({
      prompt: 'ВСЯ ПЕРЕПИСКА ЗАНОВО',
      session: { resume: { id: id(1), prompt: DELTA } },
    });

    expect(result).toEqual({
      kind: 'done',
      reply: `ответ на ${DELTA}`,
      session: id(1),
      resumed: true,
    });
    expect(disk().sessions[id(1)]?.prompts).toEqual([FULL, DELTA]);
    expect(Object.keys(disk().sessions)).toEqual([id(1)]);
  });

  it('пропавшая сессия — новая с полным промптом, пропавшая удаляется', async () => {
    const result = await turn({ session: { resume: { id: 'gone', prompt: DELTA } } });

    expect(result).toMatchObject({ kind: 'done', session: id(1), resumed: false });
    expect(disk().sessions[id(1)]?.prompts).toEqual([FULL]);
    expect(disk().log).toContain('delete gone');
  });

  it('сменённая сессия (discard) удаляется, ход идёт в новой', async () => {
    await turn({ session: {} });
    const result = await turn({ session: { discard: id(1) } });

    expect(result).toMatchObject({ kind: 'done', session: id(2), resumed: false });
    expect(disk().deleted).toEqual([id(1)]);
    expect(disk().sessions[id(2)]?.prompts).toEqual([FULL]);
  });

  it('ход без ответа удаляет продолженную сессию и id не отдаёт', async () => {
    await turn({ session: {} });
    const result = await turn({ session: { resume: { id: id(1), prompt: DELTA } } }, cli.failEnv);

    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('session');
    expect(disk().deleted).toEqual([id(1)]);
  });

  it('без session — одноразовая, как до E2b: id не отдаётся', async () => {
    const result = await turn();

    expect(result.kind).toBe('done');
    expect(result).not.toHaveProperty('session');
    expect(disk().deleted).toEqual(cli.deletesOneOff ? [id(1)] : []);
  });
});

describe('codex: параметры потока под сессию', () => {
  let dir: string;
  let store: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-live-session-codex-'));
    store = join(dir, 'store.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const log = (): string[] => (JSON.parse(readFileSync(store, 'utf8')) as Disk).log;
  const run = (session?: LiveTurnOptions['session']) =>
    new CodexAppServerTurn().run(
      {
        command: process.execPath,
        prompt: FULL,
        timeoutMs: 15_000,
        workdir: dir,
        env: { FAKE_MODE: 'ok', HOLD_MS: '30', FAKE_STORE: store },
        spawnImpl: spawnInto('fake-codex-app-server.mjs'),
        ...(session ? { session } : {}),
      },
      () => {},
    );

  it('без session поток ephemeral, с session — пишется на диск', async () => {
    await run();
    await run({});
    expect(log()).toEqual(['start thr-1 ephemeral=true', 'start thr-2 ephemeral=false']);
  });

  it('ephemeral-поток не продолжается: новый поток и полный промпт', async () => {
    await run();
    const result = await run({ resume: { id: 'thr-1', prompt: DELTA } });
    expect(result).toMatchObject({ kind: 'done', session: 'thr-2', resumed: false });
  });

  it('thread/resume несёт каталог хода, без ephemeral и без истории ходов', async () => {
    await run({});
    await run({ resume: { id: 'thr-1', prompt: DELTA } });
    expect(log()).toContain(`resume thr-1 cwd=${dir} ephemeral=- excludeTurns=true`);
  });
});

describe('goose: агент без loadSession', () => {
  it('сессия не поднимается — новая, полный промпт, прежняя удаляется', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-session-goose-'));
    const store = join(dir, 'store.json');
    try {
      const run = (env: Record<string, string>, session: LiveTurnOptions['session']) =>
        new GooseAcpTurn().run(
          {
            command: process.execPath,
            prompt: FULL,
            timeoutMs: 15_000,
            workdir: dir,
            env: { FAKE_MODE: 'ok', HOLD_MS: '30', FAKE_STORE: store, ...env },
            spawnImpl: spawnInto('fake-goose-acp.mjs'),
            session,
          },
          () => {},
        );
      await run({}, {});
      const result = await run({ FAKE_LOAD: '0' }, { resume: { id: 'ses-1', prompt: DELTA } });
      const state = JSON.parse(readFileSync(store, 'utf8')) as Disk;

      expect(result).toMatchObject({ kind: 'done', session: 'ses-2', resumed: false });
      expect(state.sessions['ses-2']?.prompts).toEqual([FULL]);
      expect(state.deleted).toEqual(['ses-1']);
      expect(state.log.some((line) => line.startsWith('load'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
