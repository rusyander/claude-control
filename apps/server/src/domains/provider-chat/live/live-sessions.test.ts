import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
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

/** Живые подделки: каталог теста удаляем только после их выхода (см. `afterEach`). */
const children = new Set<ChildProcess>();

function spawnInto(file: string): LiveTurnOptions['spawnImpl'] {
  return ((_command: string, args: string[], options: object) => {
    const child = spawn(process.execPath, [fixture(file), ...args], options);
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  }) as unknown as LiveTurnOptions['spawnImpl'];
}

/** Ждёт выхода всех подделок; задержавшуюся гасит сам, но выхода ждёт всё равно. */
async function childrenGone(): Promise<void> {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          setTimeout(() => child.kill(), 2_000).unref();
        }),
    ),
  );
  children.clear();
}

/**
 * Каталог теста — cwd подделки, а Windows не даёт удалить cwd живого процесса.
 * Под нагрузкой полного прогона подделка гаснет дольше любых повторов удаления
 * (EPERM ловили и после 4 с), поэтому сначала ждём её выхода, потом удаляем.
 */
async function removeDir(dir: string): Promise<void> {
  await childrenGone();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  afterEach(() => removeDir(dir));

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
  afterEach(() => removeDir(dir));
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
      await removeDir(dir);
    }
  });
});

describe('qwen: режим одобрения сессии', () => {
  // Qwen 0.25 без `approvalMode` открывает сессию в режиме `auto`: правка файла идёт
  // без `permission_request` (живой прогон 21.10 на локальной модели). Панель обещает
  // «спрашивать перед правками» — режим `default` обязан уходить и в новую, и в
  // продолженную сессию, иначе вопрос человеку не придёт ни разу.
  it('новая и продолженная сессии открываются в default — вопрос доходит до человека', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-session-qwen-mode-'));
    const store = join(dir, 'store.json');
    const asked: string[] = [];
    try {
      const run = (session: LiveTurnOptions['session']) =>
        new QwenServeTurn({ mcpWaitMs: 0 }).run(
          {
            command: process.execPath,
            prompt: FULL,
            timeoutMs: 15_000,
            workdir: dir,
            env: { FAKE_MODE: 'permission', HOLD_MS: '5000', MCP_MS: '0', FAKE_STORE: store },
            spawnImpl: spawnInto('fake-qwen-serve.mjs'),
            permission: {
              allowEdits: false,
              ask: async (request) => (asked.push(request.requestId), 'allow'),
            },
            session,
          },
          () => {},
        );
      const first = await run({});
      const second = await run({ resume: { id: 'ses-1', prompt: DELTA } });
      const state = JSON.parse(readFileSync(store, 'utf8')) as Disk;

      expect(first.kind === 'done' && first.reply).toContain('разрешение: proceed_once');
      expect(second).toMatchObject({ kind: 'done', session: 'ses-1', resumed: true });
      expect(second.kind === 'done' && second.reply).toContain('разрешение: proceed_once');
      expect(asked).toEqual(['req-1', 'req-1']);
      expect(state.log).toContain(`resume ses-1 cwd=${dir} mode=default`);
    } finally {
      await removeDir(dir);
    }
  });

  // Живой прогон 21.10: на «нет» человека qwen 0.25 кончает ход без единого слова
  // модели. Панель писала «CLI закончил ход без ответа» — свой же отказ человек
  // читал как сбой CLI, а сессия оставалась на диске Qwen, хотя панель её бросала.
  it('отказ человека при пустом ходе — ошибка с причиной, сессия удалена; «да» — обычный ответ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-session-qwen-refuse-'));
    const store = join(dir, 'store.json');
    try {
      const run = (decision: 'allow' | 'deny') =>
        new QwenServeTurn({ mcpWaitMs: 0 }).run(
          {
            command: process.execPath,
            prompt: FULL,
            timeoutMs: 15_000,
            workdir: dir,
            env: { FAKE_MODE: 'refuse-silent', HOLD_MS: '5000', MCP_MS: '0', FAKE_STORE: store },
            spawnImpl: spawnInto('fake-qwen-serve.mjs'),
            permission: { allowEdits: false, ask: async () => decision },
            session: {},
          },
          () => {},
        );
      const refused = await run('deny');
      const disk = JSON.parse(readFileSync(store, 'utf8')) as Disk;
      expect(refused).toEqual({
        kind: 'error',
        error: 'Qwen остановил ход после отказа в разрешении: edit notes.txt',
      });
      expect(disk.deleted).toEqual(['ses-1']);

      const allowed = await run('allow');
      expect(allowed).toMatchObject({ kind: 'done', reply: 'правка сделана', session: 'ses-2' });
    } finally {
      await removeDir(dir);
    }
  });
});
