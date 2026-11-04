import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askBodySchema, type AskFields } from '@agentdeck/contracts/core/ask';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import { randomUUID7 } from '../core-ask.ts';
import type { SessionStreamEvent } from '@agentdeck/contracts/core/session-stream';
import type { CoreIdentityDeps } from '../../../lib/listen-identity/listen-identity.ts';

/**
 * Ядро-заглушка для проверок панели (этап 10, F2, проход 2c): настоящий HTTP на loopback с теми
 * ручками, которыми панель ведёт вопрос, — `/v1/nonce`, `/v1/ask`, `/v1/tasks/:id`, поток вида
 * сеанса (SSE `page`) и `/v1/commands` (`cancel`). Дом с `procs.json` и токеном — как у живого
 * ядра, так что клиент панели (`createCoreAskPort`) идёт своим настоящим путём: поиск строки,
 * сверка, bearer, число загрузки, разбор SSE. Подменён только сам исполнитель: ход сессии — сценарий.
 *
 * Сценарий получает поля вопроса (токен моста — тоже: им сценарий зовёт панель, как мост) и пишет
 * события вида сеанса; конец сценария — конец сеанса (`done: true`).
 */

export interface FakeCoreTurn {
  fields: AskFields;
  emit: (...events: Omit<SessionStreamEvent, 'offset'>[]) => void;
  /** Решается, когда панель прислала `cancel` этой задаче. */
  cancelled: Promise<void>;
}

export interface FakeCoreOptions {
  turn?: (turn: FakeCoreTurn) => Promise<void>;
  /** Отказ ядра на `POST /v1/ask` вместо задачи (суд маршрута, переходник). */
  refuse?: { status: number; code: string; error: string; problems?: string[] };
  /**
   * Дорога ядра отказала до сессии: задача кончилась `failed`, сессий нет, причина — в шаге
   * (так живое ядро пишет `session road refused: tools-none-unsupported …`).
   */
  noSession?: { reason: string };
}

export interface FakeCore {
  home: string;
  port: number;
  asks: AskFields[];
  /** Значения `env` тела каждого вопроса (вне полей, G13); нет — `undefined` на его месте. */
  askEnvs: (Record<string, string> | undefined)[];
  cancels: string[];
  /** Задачи, чья сессия ещё идёт (сценарий не кончился): «процесс жив» для проверок обрыва. */
  running: Set<string>;
  /** Сколько чисел загрузки выдано и сколько принято доказательством. */
  nonces: { minted: number; used: number };
  identity: (port: number) => CoreIdentityDeps;
  close: () => Promise<void>;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface Task {
  sessionId: string;
  ended: boolean;
  events: SessionStreamEvent[];
  done: boolean;
  wake: () => void;
  cancel: () => void;
  cancelled: Promise<void>;
}

export async function startFakeCore(options: FakeCoreOptions = {}): Promise<FakeCore> {
  const home = mkdtempSync(join(tmpdir(), 'agentdeck-fake-core-'));
  const token = randomUUID();
  const minted = new Set<string>();
  const tasks = new Map<string, Task>();
  const core: Omit<FakeCore, 'port' | 'identity' | 'close'> = {
    home,
    asks: [],
    askEnvs: [],
    cancels: [],
    running: new Set<string>(),
    nonces: { minted: 0, used: 0 },
  };

  const startTask = (fields: AskFields): string => {
    const taskId = randomUUID7();
    let cancel = (): void => undefined;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const task: Task = {
      sessionId: randomUUID7(),
      ended: false,
      events: [],
      done: false,
      // Читателя потока ещё нет: события копятся, первый кадр отдаст всё накопленное.
      wake: () => undefined,
      cancel: () => cancel(),
      cancelled,
    };
    tasks.set(taskId, task);
    core.running.add(taskId);
    let offset = 0;
    const emit: FakeCoreTurn['emit'] = (...events) => {
      for (const e of events) task.events.push({ ...e, offset: (offset += 10) });
      task.wake();
    };
    void (options.turn ?? (async () => undefined))({ fields, emit, cancelled })
      .catch(() => undefined)
      .finally(() => {
        core.running.delete(taskId);
        task.done = true;
        task.ended = true;
        task.wake();
      });
    return taskId;
  };

  const stream = (res: ServerResponse, taskId: string, task: Task): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sent = 0;
    const push = (): void => {
      const fresh = task.events.slice(sent);
      sent = task.events.length;
      if (fresh.length === 0 && !task.done) return;
      const page = {
        taskId,
        sessionId: task.sessionId,
        adapter: 'claude',
        events: fresh,
        next: fresh.at(-1)?.offset ?? 0,
        done: task.done,
      };
      res.write(`event: page\ndata: ${JSON.stringify(page)}\n\n`);
      if (task.done) res.end();
    };
    task.wake = () => push();
    res.on('close', () => (task.wake = () => undefined));
    push();
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, {});
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/v1/nonce') {
        // Как живое ядро: номер загрузки — только UUIDv7.
        if (!UUIDV7.test(url.searchParams.get('page') ?? '')) {
          return json(res, 400, { code: 'bad-page', error: 'page must be UUIDv7' });
        }
        const nonce = randomUUID();
        minted.add(nonce);
        core.nonces.minted += 1;
        return json(res, 200, { nonce });
      }
      if (
        req.method === 'POST' &&
        (url.pathname === '/v1/ask' || url.pathname === '/v1/commands')
      ) {
        const body = (await readBody(req)) as { proof?: { nonce?: string }; kind?: string };
        const nonce = body?.proof?.nonce;
        if (!nonce || !minted.delete(nonce)) return json(res, 403, { code: 'proof-required' });
        core.nonces.used += 1;
        if (url.pathname === '/v1/commands') {
          // Конверт и поля команды судит та же схема, что у живого ядра: команда, которую ядро
          // отвергло бы (400), здесь тоже не считается отправленной.
          const command = parseCommand(body);
          if (!command.ok) return json(res, 400, { code: 'bad-command', issues: command.issues });
          const taskId = command.command.target.taskId;
          core.cancels.push(taskId);
          tasks.get(taskId)?.cancel();
          return json(res, 202, { ok: true });
        }
        const parsed = askBodySchema.safeParse(body);
        if (!parsed.success) {
          // Причины — как у живого ядра: тест видит, какое поле панель собрала не так.
          return json(res, 400, {
            code: 'bad-ask',
            error: 'bad ask',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        core.asks.push(parsed.data.fields);
        core.askEnvs.push(parsed.data.env);
        if (options.refuse) {
          const { status, ...rest } = options.refuse;
          return json(res, status, rest);
        }
        return json(res, 202, { taskId: startTask(parsed.data.fields), replayed: false });
      }
      if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'tasks' && parts[2]) {
        const task = tasks.get(parts[2]);
        if (!task) return json(res, 404, {});
        if (parts.length === 3) {
          if (options.noSession) {
            return json(res, 200, {
              task: null,
              live: true,
              view: {
                ended: 'failed',
                sessions: [],
                steps: [{ reason: options.noSession.reason }],
              },
            });
          }
          return json(res, 200, {
            task: null,
            live: true,
            view: {
              ended: task.ended ? 'done' : null,
              sessions: [{ sessionId: task.sessionId }],
            },
          });
        }
        if (parts[3] === 'sessions' && parts[5] === 'stream') return stream(res, parts[2], task);
      }
      return json(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, 'token'), token);
  writeFileSync(
    join(home, 'procs.json'),
    JSON.stringify({
      v: 1,
      cores: [
        {
          pid: process.pid,
          pidStart: 'fake',
          port,
          url: `http://127.0.0.1:${port}`,
          startedAt: Date.now(),
          home,
          portDecision: { rejected: [] },
          build: 'fake',
          bootId: 'fake',
        },
      ],
    }),
  );
  return {
    ...core,
    port,
    // Сверка строки — по таблице слушателей ОС; здесь её отвечает сама заглушка: порт слушает
    // этот процесс, и он жив. Подменена граница ОС, а не клиент.
    identity: () => ({
      tcp: async () => ({
        value: [{ state: 'listen', localAddress: '127.0.0.1', localPort: port, pid: process.pid }],
      }),
      isAlive: async () => 'alive',
      exists: async () => true,
    }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
