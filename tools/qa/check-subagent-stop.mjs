/**
 * «Остановить» у субагента в дереве агентов — на настоящем CLI.
 *
 * Путь целиком: реестр прогонов панели (`ChatRunRegistry.stopSubagent`) →
 * живая сессия (`LiveSession.stopTask`) → `control_request` `stop_task` в stdin
 * настоящего `claude` → его `control_response` → субагент снят. Модель —
 * заглушка на своём порту (`ANTHROPIC_BASE_URL`), каталог конфигурации —
 * одноразовый: ни `~/.claude`, ни стенд человека не трогаются.
 *
 * Сценарий заглушки:
 * - главный агент первым ходом запускает фонового субагента (`Agent`,
 *   `run_in_background`) и кончает ход;
 * - субагенту заглушка не отвечает — держит его запрос открытым, пока его не
 *   оборвут: так субагент гарантированно «идёт» в момент остановки.
 *
 * Что проверяется:
 * 1. Между ходами у разговора есть кому послать `stop_task` (`canStopSubagents`).
 * 2. `stopSubagent` с id субагента — CLI подтвердил (`ok`).
 * 3. После этого CLI оборвал запрос субагента к модели — он правда остановлен.
 * 4. Чужой id — CLI тоже отвечает «готово» (замер 2.1.310), но настоящий
 *    субагент при этом работает дальше: подтверждение CLI ≠ остановка.
 * 5. Разговор без живого процесса — `absent`, без записи куда-либо.
 *
 * Запуск: `node tools/qa/check-subagent-stop.mjs`. Нужен установленный `claude`
 * (`CLAUDE_CLI` — свой путь).
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { NotChecked, reporter } from './throwaway-stand.mjs';

const MAIN_MARK = 'STOPPROBE-MAIN';
const SUB_MARK = 'STOPPROBE-SUB';

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const start = (id, model) => [
  'message_start',
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
];

function textReply(res, model, text) {
  sse(res, [
    start(`msg_${Date.now()}`, model),
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
  res.end();
}

function toolReply(res, model, name, input) {
  sse(res, [
    start(`msg_${Date.now()}`, model),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_stop_${Date.now()}`, name, input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
  res.end();
}

/** Первая реплика человека в запросе — по ней видно, чей это запрос. */
function firstUserText(body) {
  const first = (body.messages ?? []).find((message) => message.role === 'user');
  const content = first?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => block.text ?? '').join('\n');
}

const hasToolResult = (body) =>
  (body.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
  );

function startStub() {
  const state = { agentTool: '', subHeld: 0, subAborted: 0, mainTurns: 0, requests: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      state.requests += 1;
      const model = body.model ?? 'stub';
      const said = firstUserText(body);
      if (said.includes(SUB_MARK)) {
        // Субагент: держим запрос, пока CLI его не оборвёт.
        state.subHeld += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: ping\ndata: {"type":"ping"}\n\n`);
        const keep = setInterval(() => res.write(`event: ping\ndata: {"type":"ping"}\n\n`), 2000);
        res.on('close', () => {
          clearInterval(keep);
          if (!res.writableEnded) state.subAborted += 1;
        });
        return;
      }
      if (said.includes(MAIN_MARK) && !hasToolResult(body)) {
        const tool = (body.tools ?? []).find(
          (item) => item.name === 'Agent' || item.name === 'Task',
        );
        if (tool) {
          state.agentTool = tool.name;
          state.mainTurns += 1;
          toolReply(res, model, tool.name, {
            description: 'stop probe',
            prompt: `${SUB_MARK} wait for the model`,
            subagent_type: 'general-purpose',
            run_in_background: true,
          });
          return;
        }
      }
      textReply(res, model, 'ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => server.close(),
      }),
    );
  });
}

/** id субагента — из его meta в одноразовом каталоге конфигурации. */
function findAgentId(configDir) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return undefined;
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const match = /^agent-(.+)\.meta\.json$/.exec(entry.name);
      if (match) return match[1];
      if (entry.isDirectory() && depth < 4) {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(projects, 0);
}

const { check, finish } = reporter();
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-stop-work-')));
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-stop-home-')));
const stub = await startStub();
let runs;
const key = 'stop-probe';
try {
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  runs = new ChatRunRegistry();
  runs.setPlatformRouting(() => ({
    env: {
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'stop-stub-token',
      ANTHROPIC_API_KEY: 'stop-stub-token',
      ANTHROPIC_MODEL: 'stub-stop',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  }));
  console.log(`Заглушка модели ${stub.url}\n`);
  runs.start(
    key,
    {
      prompt: `${MAIN_MARK} запусти субагента`,
      cwd: work,
      configDir: home,
      ...(process.env.CLAUDE_CLI ? { command: process.env.CLAUDE_CLI } : {}),
      permissionMode: 'default',
      permissionPrompt: { runId: key, baseUrl: 'http://127.0.0.1:1' },
    },
    { origin: 'chat' },
  );
  for (let i = 0; i < 240 && stub.state.subHeld === 0; i += 1) await wait(250);
  if (stub.state.requests === 0)
    throw new NotChecked('CLI не обратился к заглушке модели — нет `claude`?');
  check(
    'главный агент запустил субагента вызовом Agent/Task',
    stub.state.agentTool !== '',
    JSON.stringify(stub.state),
  );
  check('субагент идёт: его запрос к модели держится открытым', stub.state.subHeld > 0);
  for (let i = 0; i < 120 && runs.isRunning(key); i += 1) await wait(250);
  const agentId = findAgentId(home);
  check('у субагента есть id (meta в каталоге сессии)', Boolean(agentId), String(agentId));

  check('между ходами разговору есть кому послать stop_task', runs.canStopSubagents(key) === true);
  // Замер 25.10 (claude 2.1.310): на чужой id CLI тоже отвечает успехом. Значит,
  // подтверждение — только «запрос принят», а снят ли субагент, говорит его след
  // в транскрипте; панель так и пишет («остановка запрошена»).
  const refused = await runs.stopSubagent(key, 'no-such-agent-id');
  await wait(2000);
  check(
    'чужой id — субагент работает дальше (подтверждение CLI ≠ остановка)',
    refused !== 'absent' && stub.state.subAborted === 0,
    `${JSON.stringify(refused)} ${JSON.stringify(stub.state)}`,
  );
  const aborted = stub.state.subAborted;
  const reply = agentId ? await runs.stopSubagent(key, agentId) : 'no-agent';
  check(
    'stop_task с id субагента — CLI подтвердил',
    reply !== 'absent' && reply?.outcome === 'ok',
    JSON.stringify(reply),
  );
  for (let i = 0; i < 40 && stub.state.subAborted === aborted; i += 1) await wait(250);
  check(
    'после остановки CLI оборвал запрос субагента к модели',
    stub.state.subAborted > aborted,
    JSON.stringify(stub.state),
  );
  // Дерево панели по транскрипту: остановленный субагент больше не «идёт».
  const { readChatProgressWithTree } =
    await import('../../apps/server/src/domains/chat/subagent-tree/subagent-tree.ts');
  const sessionId = runs.active?.().find((run) => run.chatId === key)?.sessionId;
  let node;
  for (let i = 0; i < 40; i += 1) {
    const chats = readdirSync(join(home, 'projects'), { withFileTypes: true }).flatMap((dir) =>
      dir.isDirectory()
        ? readdirSync(join(home, 'projects', dir.name))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => name.replace(/\.jsonl$/, ''))
        : [],
    );
    const id = sessionId ?? chats[0];
    node = id
      ? readChatProgressWithTree(join(home, 'projects'), id).agents.find(
          (agent) => agent.agentId === agentId,
        )
      : undefined;
    if (node && node.status !== 'running') break;
    await wait(250);
  }
  check(
    'дерево панели: остановленный субагент не числится идущим',
    Boolean(node) && node.status !== 'running',
    JSON.stringify(node ?? null).slice(0, 400),
  );
  if (process.env.STOP_DUMP) console.log(JSON.stringify(node, null, 2));
  // CLI пишет итог остановленного `<status>killed</status>` (замер 25.10) — это
  // решение человека, не падение: узел называет его «остановлен».
  check(
    'дерево панели: остановленный помечен «остановлен», а не «упал»',
    node?.stopped === true,
    JSON.stringify(node ?? null).slice(0, 300),
  );
  const absent = await runs.stopSubagent('no-such-chat', agentId ?? 'x');
  check('разговор без живого процесса — absent', absent === 'absent', JSON.stringify(absent));
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  }
} finally {
  runs?.closeLive?.(key);
  runs?.stopAll?.();
  await wait(1500);
  stub.close();
  for (const dir of [work, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* процесс ещё держит файл — временная папка уйдёт с чисткой ОС */
    }
  }
}
if (process.exitCode !== 2) finish();
