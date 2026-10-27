import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KimiServerTurn } from './kimi-server.ts';
import { QwenServeTurn } from './qwen-serve.ts';
import type { LiveTurn, LiveTurnOptions } from './types.ts';

/**
 * @covers live/{kimi-server,qwen-serve}.ts — сессия, остановленная до того, как CLI принял реплику хода
 * @scenario P-24 (паритет d9869abf:9): пауза группы через миг после старта
 *   продолжения снимает ход, пока Qwen ждёт свои MCP, а Kimi — ответ на отправку.
 *   Сессия уже заведена, реплики в ней нет. Отданный панели id значил бы «сессия
 *   видела всё до этой реплики включительно» (`covered`), и «Продолжить» слало бы
 *   в неё одно общее слово — вводная продолжения терялась. Не принявшая реплику
 *   сессия id не отдаёт: новая удаляется, продолженная остаётся при прежней отметке.
 *
 * Подделки CLI — настоящие дочерние процессы (`fixtures/`), «диск» CLI — FAKE_STORE.
 */

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const children = new Set<ChildProcess>();

function spawnInto(file: string): LiveTurnOptions['spawnImpl'] {
  return ((_command: string, args: string[], options: object) => {
    const child = spawn(process.execPath, [fixture(file), ...args], options);
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  }) as unknown as LiveTurnOptions['spawnImpl'];
}

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

interface Disk {
  sessions: Record<string, { prompts: string[] }>;
  deleted: string[];
  log: string[];
}

const BRIEF = 'SENTINEL_HANDOFF вводная продолжения';
const EARLIER = 'прежняя реплика';

interface Cli {
  readonly name: string;
  readonly file: string;
  readonly make: () => LiveTurn;
  /** Окно «сессия есть, реплики нет», в котором ход снимают. */
  readonly env: Record<string, string>;
  /** Новая сессия без реплики удаляется на сервере CLI (процесс ещё жив). */
  readonly removesFresh: boolean;
}

const CLIS: Cli[] = [
  {
    name: 'qwen',
    file: 'fake-qwen-serve.mjs',
    // MCP поднимаются 4 с — панель ждёт их до отправки реплики.
    make: () => new QwenServeTurn({ mcpWaitMs: 8_000 }),
    env: { FAKE_MODE: 'inject', HOLD_MS: '30', MCP_MS: '4000', MCP_ON_RESUME: '1' },
    // `stop` гасит процесс qwen сразу — удалять сессию уже некому, её уносит дом Qwen.
    removesFresh: false,
  },
  {
    name: 'kimi',
    file: 'fake-kimi-server.mjs',
    make: () => new KimiServerTurn({ pollMs: 20 }),
    env: { FAKE_MODE: 'ok', HOLD_MS: '30', ACCEPT_DELAY_MS: '4000' },
    removesFresh: true,
  },
];

describe.each(CLIS)('$name: ход снят до того, как CLI принял реплику (P-24)', (cli) => {
  let dir = '';
  afterEach(async () => {
    await childrenGone();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), `cc-live-stop-${cli.name}-`));
    const store = join(dir, 'store.json');
    const disk = (): Disk =>
      existsSync(store)
        ? (JSON.parse(readFileSync(store, 'utf8')) as Disk)
        : { sessions: {}, deleted: [], log: [] };
    const options = (
      prompt: string,
      session: LiveTurnOptions['session'],
      env: Record<string, string>,
    ): LiveTurnOptions => ({
      command: process.execPath,
      prompt,
      timeoutMs: 20_000,
      workdir: dir,
      env: { ...env, FAKE_STORE: store },
      spawnImpl: spawnInto(cli.file),
      session,
    });
    /** Ход снимается, как только CLI завёл (или поднял) сессию — строка `mark` в его журнале. */
    const stopped = async (prompt: string, session: LiveTurnOptions['session'], mark: RegExp) => {
      const turn = cli.make();
      const running = turn.run(options(prompt, session, cli.env), () => {});
      const until = Date.now() + 10_000;
      while (!disk().log.some((line) => mark.test(line)) && Date.now() < until) {
        await new Promise((done) => setTimeout(done, 25));
      }
      // Сессия на «диске» — панель уже в окне ожидания перед отправкой реплики.
      await new Promise((done) => setTimeout(done, 300));
      turn.stop();
      return running;
    };
    return { disk, options, stopped };
  };

  it('новая сессия без реплики: id не отдаётся, сессия удалена', async () => {
    const { disk, stopped } = setup();

    const result = await stopped(BRIEF, {}, /^new ses-1/);

    expect(result).not.toHaveProperty('session');
    expect(disk().sessions['ses-1']?.prompts ?? []).not.toContain(BRIEF);
    if (cli.removesFresh) expect(disk().deleted).toContain('ses-1');
  });

  it('продолженная сессия без реплики: id не отдаётся, прежняя сессия цела', async () => {
    const { disk, options, stopped } = setup();
    const quick = { ...cli.env, MCP_MS: '0', ACCEPT_DELAY_MS: '0' };
    const first = await cli.make().run(options(EARLIER, {}, quick), () => {});
    expect(first).toMatchObject({ kind: 'done', session: 'ses-1' });

    const result = await stopped(
      'вся переписка',
      { resume: { id: 'ses-1', prompt: BRIEF } },
      /^(open|resume) ses-1/,
    );

    expect(result).not.toHaveProperty('session');
    expect(disk().sessions['ses-1']?.prompts).toEqual([EARLIER]);
    expect(disk().deleted).not.toContain('ses-1');
  });
});
