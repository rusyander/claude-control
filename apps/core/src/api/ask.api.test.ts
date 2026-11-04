import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { createAskBridgeBook, createAskTask, replayAsk } from '../conductor/ask/index.ts';
import { testEnv } from '../conductor/split/__fixtures__/split-stand.ts';
import { createTaskEnvBook, type TaskEnvBook } from '../conductor/task-env/index.ts';
import { join } from 'node:path';
import { TASK_FILES } from '../journal/journal.types.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { loginRoute } from '../bootstrap/__fixtures__/road-start.ts';
import { FORWARDED_PEER_HEADER } from './auth.ts';
import type { AskPort } from './ask.ts';
import { SESSION_PID, startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/ask` (этап 10, F2) по настоящему HTTP: корпус атак P41/P97 — токен сессии, пир из
 * дерева сессии, пересылка без подписи, без числа страницы, чужое число, повтор числа — отказ и
 * строка `ask.refused`; лишнее поле (свой сервер MCP, команда) — 400 разбора; честное
 * доказательство создаёт задачу `ask@1` без репозитория. Токен моста не ложится в журнал.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

interface Refusal {
  cmdId: string | null;
  code: string;
  reason: string;
}

async function askStand(withTaskEnv = false): Promise<{
  s: Stand;
  refused: Refusal[];
  book: ReturnType<typeof createAskBridgeBook>;
  taskEnv: TaskEnvBook;
}> {
  const refused: Refusal[] = [];
  const book = createAskBridgeBook();
  const taskEnv = createTaskEnvBook();
  // Порт собирается после стенда (ему нужен реестр стенда): стенд читает его через держатель.
  const holder: { port?: AskPort } = {};
  const s = await startStand(undefined, { ask: () => holder.port });
  const env = testEnv(s.layout.scenarios);
  if (withTaskEnv) env.taskEnv = taskEnv;
  env.allowedRoutes = () => ({
    routes: [
      {
        adapter: claudeRunFacts.id,
        route: { kind: 'cli-login', id: loginRoute(claudeRunFacts.id) },
        modelPattern: '*',
      },
    ],
    level: 2,
  });
  holder.port = {
    replay: (cmdId) => replayAsk(s.registry, cmdId),
    create: (body) => createAskTask(body, s.registry, env, book),
    refused: (cmdId, code, reason) => void refused.push({ cmdId, code, reason }),
  };
  stand = s;
  return { s, refused, book, taskEnv };
}

const TOKEN = randomBytes(32).toString('base64url');

function body(proof: object, fields: Record<string, unknown> = {}, cmdId = newId()) {
  return {
    cmdId,
    fields: {
      title: 'вопрос группы',
      prompt: 'Ответь одним словом: да или нет?',
      tools: 'panel-bridge',
      panelBridge: { url: 'http://127.0.0.1:49999', token: TOKEN, conversation: 'conv-1' },
      ...fields,
    },
    proof,
  };
}

async function post(
  s: Stand,
  payload: unknown,
  opts: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = opts.token === undefined ? TOKENS.core : opts.token;
  const res = await fetch(`${s.url}/v1/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /v1/ask: proof of a human, refusals journaled (stage 10 F2, P41/P97)', () => {
  it('attack corpus through the real HTTP path is refused and each refusal reaches the core journal port', async () => {
    const { s, refused } = await askStand();
    const tasksBefore = s.registry.list().length;
    // Нет токена канала.
    expect((await post(s, body({}), { token: null })).status).toBe(401);
    // Токен сессии — подделка полномочий, даже с честным числом.
    const forged = await post(s, body(await s.nonce()), { token: TOKENS.session });
    expect(forged).toMatchObject({ status: 403, body: { code: 'forged-authority' } });
    // Пир из дерева сессии (процесс модели с токеном ядра).
    s.peer.direct = SESSION_PID;
    expect((await post(s, body(await s.nonce()))).body.code).toBe('forged-authority');
    s.peer.direct = 4242;
    // Переслано непроверенным звеном — только подпись устройства.
    const hop = await post(s, body(await s.nonce()), { headers: { [FORWARDED_PEER_HEADER]: '1' } });
    expect(hop.body.code).toBe('signature-required');
    // Без доказательства человека.
    expect((await post(s, body({}))).body.code).toBe('proof-required');
    // Число чужой загрузки страницы.
    const foreign = await s.nonce();
    expect((await post(s, body({ nonce: foreign.nonce, page: newId() }))).body.code).toBe(
      'nonce-invalid',
    );
    expect(s.registry.list().length).toBe(tasksBefore);
    // Число, уже потраченное честным вопросом, второй раз не годится.
    const spent = await s.nonce();
    expect((await post(s, body(spent))).status).toBe(202);
    expect((await post(s, body(spent))).body.code).toBe('nonce-invalid');
    expect(s.registry.list().length).toBe(tasksBefore + 1);
    expect(refused.map((r) => r.code)).toEqual([
      'token-required',
      'forged-authority',
      'forged-authority',
      'signature-required',
      'proof-required',
      'nonce-invalid',
      'nonce-invalid',
    ]);
    // Отказ не несёт токен моста ни в одной строке журнала ядра.
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
  });

  it('a caller-supplied MCP server, command or non-loopback bridge is a 400 parse refusal, never a task', async () => {
    const { s } = await askStand();
    const tasksBefore = s.registry.list().length;
    const bad = [
      { mcpServers: { evil: { command: 'node', args: ['x.mjs'] } } },
      { command: 'node evil.mjs' },
      { panelBridge: { url: 'http://evil.example:80', token: TOKEN } },
      { panelBridge: { url: 'http://127.0.0.1:5178', token: TOKEN, command: 'node' } },
      { tools: 'all' },
      { tools: 'none' },
      { tools: 'panel-bridge', panelBridge: undefined },
    ];
    for (const fields of bad) {
      const got = await post(s, body(await s.nonce(), fields));
      expect(got.status, JSON.stringify(fields)).toBe(400);
    }
    expect(s.registry.list().length).toBe(tasksBefore);
  });

  it('an honest proof creates an ask@1 task with no repository, scratch placement and running state; the bridge token stays out of the journal; the same cmdId replays', async () => {
    const { s, book } = await askStand();
    const cmdId = newId();
    const created = await post(s, body(await s.nonce(), {}, cmdId));
    expect(created.status).toBe(202);
    const taskId = created.body.taskId as string;
    const task = s.registry.live(taskId)!;
    expect(task.state.created).toMatchObject({
      repos: [],
      scenario: { id: 'ask', version: 1 },
      placement: 'scratch',
      ask: {
        tools: 'panel-bridge',
        bridge: { url: 'http://127.0.0.1:49999', conversation: 'conv-1' },
      },
    });
    expect(task.state.task).toBe('running');
    expect(book.get(taskId)).toBe(TOKEN);
    const raw = readFileSync(join(task.dir, TASK_FILES.journal), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('Ответь одним словом');
    // Вопрос — артефакт задачи, не строка журнала.
    expect(readFileSync(join(task.dir, 'request.md'), 'utf8')).toBe(
      'Ответь одним словом: да или нет?',
    );
    // Повтор того же ключа — та же задача, второй нет.
    const again = await post(s, body(await s.nonce(), {}, cmdId));
    expect(again).toMatchObject({ status: 200, body: { taskId, replayed: true } });
  });

  it('an adapter outside the allowed set is a 422: the task fails at once and its bridge token is dropped', async () => {
    const { s, book, refused } = await askStand();
    const before = new Set(s.registry.list().map((t) => t.taskId));
    const got = await post(s, body(await s.nonce(), { adapter: 'nonexistent-cli' }));
    expect(got).toMatchObject({ status: 422, body: { code: 'ask-refused' } });
    expect(book.size()).toBe(0);
    expect(refused.at(-1)?.code).toBe('ask-refused');
    // Задача упала сразу, и её журнал называет причину сигналом каталога (не сырой строкой).
    const failed = s.registry.list().find((t) => !before.has(t.taskId));
    expect(failed?.state).toBe('failed');
    const signal = readJournalLines(
      join(s.layout.tasks, failed!.taskId),
      failed!.taskId,
    ).lines.find((l) => l.kind === 'signal');
    expect(signal?.data).toMatchObject({ signal: 'ask-refused', severity: 'warn' });
  });

  it('the panel kit (G13): session takes only append + env names (plugins, narrowing, argv → 400); names are judged like chat carry (core-owned, missing, orphan values → 422, no task); an honest kit lands names in the journal and values only in the task env book', async () => {
    const { s, taskEnv } = await askStand(true);
    const tasksBefore = s.registry.list().length;
    const kit = (session: object, env?: Record<string, string>) => ({
      ...body({}, { session }),
      ...(env ? { env } : {}),
    });
    const absent = join(s.layout.root, 'kit-plugin');
    for (const session of [
      { plugins: [absent] },
      { settingSources: ['user'] },
      { builtinTools: ['Read'] },
      { args: ['--yolo'] },
      { brief: 'none' },
    ]) {
      const got = await post(s, { ...kit(session), proof: await s.nonce() });
      expect(got.status, JSON.stringify(session)).toBe(400);
    }
    const refusedBy = async (session: object, env: Record<string, string> | undefined) =>
      (await post(s, { ...kit(session, env), proof: await s.nonce() })).body;
    expect(await refusedBy({ env: ['PATH'] }, { PATH: 'C:\\evil' })).toMatchObject({
      code: 'ask-refused',
    });
    expect(JSON.stringify(await refusedBy({ env: ['QWEN_HOME'] }, undefined))).toContain(
      'session.env: no value for QWEN_HOME',
    );
    expect(
      JSON.stringify(await refusedBy({ env: ['QWEN_HOME'] }, { QWEN_HOME: 'x', OTHER: 'y' })),
    ).toContain('env: OTHER not named in session.env');
    expect(s.registry.list().length).toBe(tasksBefore);

    const home = join(s.layout.root, 'kit', 'qwen-home');
    const ok = await post(s, {
      ...kit({ append: 'правила набора', env: ['QWEN_HOME'] }, { QWEN_HOME: home }),
      proof: await s.nonce(),
    });
    expect(ok.status).toBe(202);
    const task = s.registry.live(ok.body.taskId as string)!;
    expect(task.state.created?.session).toEqual({ append: 'правила набора', env: ['QWEN_HOME'] });
    expect(taskEnv.get(task.taskId)).toEqual({ QWEN_HOME: home });
    const raw = readFileSync(join(task.dir, TASK_FILES.journal), 'utf8');
    expect(raw).not.toContain('qwen-home');
  });

  it('a kit with env names on a core without a task env book is a 422, never a task that runs on the core env', async () => {
    const { s } = await askStand(false);
    const got = await post(s, {
      ...body({}, { session: { env: ['QWEN_HOME'] } }),
      env: { QWEN_HOME: join(s.layout.root, 'q') },
      proof: await s.nonce(),
    });
    expect(got).toMatchObject({ status: 422, body: { code: 'ask-refused' } });
    expect(JSON.stringify(got.body)).toContain('no task env book');
  });

  it('without a running conductor an honest ask answers 501 not-wired', async () => {
    const s = await startStand(undefined, {
      ask: () => ({
        replay: () => undefined,
        create: async () => ({ status: 501 }),
        refused: () => undefined,
      }),
    });
    stand = s;
    const got = await post(s, body(await s.nonce()));
    expect(got).toMatchObject({ status: 501, body: { code: 'not-wired' } });
  });
});
