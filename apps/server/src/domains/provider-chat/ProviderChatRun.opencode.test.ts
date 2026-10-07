import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../providers/registry.ts';
import type { OpencodeServe, OpencodeServeDeps } from '../opencode-serve.ts';
import { ProviderChatRun } from './ProviderChatRun.ts';

/**
 * OpenCode в чате (L-opencode). Сессия `opencode serve` получает каталог
 * разговора и «Разрешить правки» (иначе работала бы в каталоге панели и без
 * прав), одиночный `opencode run` — `--auto` только при включённых правках и
 * ЗАКРЫТЫЙ stdin: `run` читает stdin, когда это не терминал, и с открытой трубой
 * не выходит никогда (проверено 1.18.34). Живой прогон — `tools/qa/check-cli-opencode.mjs`.
 */

type SpawnImpl = Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

const history = [
  { id: 'm1', role: 'user' as const, content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' },
];

/** Сессия, которой нет: путь уходит в одиночный запуск. */
const noSession = {
  ask: async () => undefined,
  steer: async () => false,
} as unknown as OpencodeServe;

describe('OpenCode в чате панели', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-opencode-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('сессия получает каталог разговора и права разговора', async () => {
    let deps: OpencodeServeDeps | undefined;
    const serve = {
      ask: async (_id: string, _text: string, given: OpencodeServeDeps) => {
        deps = given;
        return { reply: 'ответ', sessionId: 'ses_1' };
      },
      steer: async () => false,
    } as unknown as OpencodeServe;
    const ask = async () => 'deny' as const;
    const events: { type: string }[] = [];

    await new ProviderChatRun().start(
      {
        provider: getProvider('opencode'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        workdir: 'C:/work/project',
        detect: () => true,
        sessionServe: serve,
        permission: { allowEdits: false, ask },
      },
      (event) => events.push(event),
    );

    expect(deps?.workdir).toBe('C:/work/project');
    expect(deps?.permission?.allowEdits).toBe(false);
    expect(deps?.permission?.ask).toBe(ask);
    expect(events.at(-1)).toMatchObject({ type: 'done', transport: 'session' });
  });

  const oneShot = async (allowEdits?: boolean, workdir?: string) => {
    const seen: { args: string[]; stdinEnded: boolean; cwd?: string; pwd?: string }[] = [];
    const spawnImpl = ((
      command: string,
      args: string[],
      spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      const record = {
        args: [command, ...args],
        stdinEnded: false,
        cwd: spawnOptions?.cwd,
        pwd: spawnOptions?.env?.PWD,
      };
      seen.push(record);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => {},
        on: () => {},
        // Как `opencode run`: ответ и выход — только после конца stdin.
        end: () => {
          record.stdinEnded = true;
          setTimeout(() => {
            (child.stdout as EventEmitter).emit('data', Buffer.from('ок\r\n'));
            child.emit('close', 0);
          }, 0);
        },
      };
      child.kill = () => child.emit('close', null);
      return child;
    }) as unknown as SpawnImpl;
    const events: { type: string; reply?: string }[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('opencode'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        sessionServe: noSession,
        spawnImpl,
        timeoutMs: 2_000,
        ...(workdir ? { workdir } : {}),
        ...(allowEdits === undefined ? {} : { permission: { allowEdits } }),
      },
      (event) => events.push(event),
    );
    return { seen, last: events.at(-1) };
  };

  it('одиночный запуск закрывает stdin — иначе run не выходит (ответ, не таймаут)', async () => {
    const { seen, last } = await oneShot(false);
    expect(seen[0]?.stdinEnded).toBe(true);
    expect(last).toMatchObject({ type: 'done', reply: 'ок', transport: 'stream' });
  });

  it('PWD процесса — каталог разговора: `opencode run` берёт проект из PWD, а не из cwd', async () => {
    const workdir = join(dir, 'project');
    const { seen } = await oneShot(true, workdir);
    expect(seen[0]?.cwd).toBe(workdir);
    expect(seen[0]?.pwd).toBe(workdir);
  });

  it('--auto доходит до запуска только при включённых правках', async () => {
    // Командная строка целиком: на Windows без CLI в PATH запуск идёт через cmd.exe.
    const line = async (allowEdits?: boolean) =>
      ((await oneShot(allowEdits)).seen[0]?.args ?? []).join(' ');
    expect(await line(true)).toMatch(/\brun --auto\b/);
    expect(await line(false)).not.toContain('--auto');
    expect(await line()).not.toContain('--auto');
  });

  it('argv каталога: run, --auto по правкам, промпт — последний отдельный элемент', () => {
    const args = getProvider('opencode').assistant?.oneShotArgs;
    expect(args?.('скажи "привет"\nвторая строка', { allowEdits: true })).toEqual([
      'run',
      '--auto',
      'скажи "привет"\nвторая строка',
    ]);
    expect(args?.('вопрос', { allowEdits: false })).toEqual(['run', 'вопрос']);
    expect(args?.('вопрос')).toEqual(['run', 'вопрос']);
  });
});

describe('ассистент формы: one-shot OpenCode тоже закрывает stdin', () => {
  it('runAssistant без сессии → run выходит, ответ приходит', async () => {
    const { runAssistant } = await import('../assistant-runner.ts');
    const ended = vi.fn();
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => {},
        on: () => {},
        end: () => {
          ended();
          setTimeout(() => {
            (child.stdout as EventEmitter).emit('data', Buffer.from('ответ'));
            child.emit('close', 0);
          }, 0);
        },
      };
      child.kill = () => child.emit('close', null);
      return child;
    });
    const result = await runAssistant(
      getProvider('opencode'),
      [{ role: 'user', content: 'вопрос' }],
      {
        appDataDir: 'C:/tmp/nowhere',
        conversationId: 'conv-1',
        sessionServe: noSession,
        detect: () => true,
        spawnImpl: spawnImpl as never,
        timeoutMs: 2_000,
      },
    );
    expect(ended).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, transport: 'one-shot', reply: 'ответ' });
  });
});

/**
 * Контур окружением прогона (X7). Сервер сессий OpenCode общий на все разговоры
 * и поднят со своим окружением, живой сервер Kimi берёт модель из своего
 * `/config`: адрес контура ЭТОГО прогона ни тот, ни другой не получил бы, и ход
 * ушёл бы провайдером человека. С окружением — только одиночный запуск.
 */
describe('прогон с окружением контура минует общие серверы', () => {
  const ROUTE = { OPENCODE_CONFIG_CONTENT: '{"enabled_providers":["contour"]}' };

  const recordingSpawn = (seen: { env?: NodeJS.ProcessEnv }[]) =>
    ((_command: string, _args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ env: spawnOptions?.env });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => {},
        on: () => {},
        end: () =>
          setTimeout(() => {
            (child.stdout as EventEmitter).emit('data', Buffer.from('ок'));
            child.emit('close', 0);
          }, 0),
      };
      child.kill = () => child.emit('close', null);
      return child;
    }) as unknown as SpawnImpl;

  it('OpenCode: сессию не спрашивают, одиночный запуск получает адрес контура', async () => {
    const ask = vi.fn(async () => ({ reply: 'мимо контура', sessionId: 's' }));
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    const events: { type: string; reply?: string }[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('opencode'),
        history,
        chatId: 'chat',
        appDataDir: 'C:/tmp/nowhere',
        detect: () => true,
        sessionServe: { ask, steer: async () => false } as unknown as OpencodeServe,
        spawnImpl: recordingSpawn(seen),
        timeoutMs: 2_000,
        platformEnv: ROUTE,
      },
      (event) => events.push(event),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(seen[0]?.env?.OPENCODE_CONFIG_CONTENT).toBe(ROUTE.OPENCODE_CONFIG_CONTENT);
    expect(events.at(-1)).toMatchObject({ type: 'done', reply: 'ок' });
  });

  it('Kimi: живой сервер не поднимается, ход идёт одиночным запуском', async () => {
    const liveTurn = vi.fn(() => undefined);
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('kimi'),
        history,
        chatId: 'chat',
        appDataDir: 'C:/tmp/nowhere',
        detect: () => true,
        liveTurn,
        spawnImpl: recordingSpawn(seen),
        timeoutMs: 2_000,
        platformEnv: { KIMI_MODEL_BASE_URL: 'http://127.0.0.1:1/c/v1' },
      },
      () => {},
    );
    expect(liveTurn).not.toHaveBeenCalled();
    expect(seen[0]?.env?.KIMI_MODEL_BASE_URL).toBe('http://127.0.0.1:1/c/v1');
  });

  it('ассистент формы: сессия OpenCode не спрашивается при окружении прогона', async () => {
    const { runAssistant } = await import('../assistant-runner.ts');
    const ask = vi.fn(async () => ({ reply: 'мимо контура', sessionId: 's' }));
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    const result = await runAssistant(
      getProvider('opencode'),
      [{ role: 'user', content: 'вопрос' }],
      {
        appDataDir: 'C:/tmp/nowhere',
        conversationId: 'conv-1',
        sessionServe: { ask, steer: async () => false } as unknown as OpencodeServe,
        detect: () => true,
        spawnImpl: recordingSpawn(seen) as never,
        timeoutMs: 2_000,
        env: ROUTE,
      },
    );
    expect(ask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, transport: 'one-shot' });
  });
});
