// Агент панели у чужого CLI — живьём: одноразовая панель, НАСТОЯЩИЙ Qwen Code
// (`qwen`, из `STEER_CLI_DIR` или PATH) и заглушка модели OpenAI chat/completions.
// Доказательство — не текст ответа, а то, что прошло по проводу:
//   - модель увидела ТОЛЬКО инструменты переходника панели (ни оболочки, ни файлов);
//   - в системном промпте модели — дописка агента панели;
//   - вызов `where_am_i` прошёл через настоящий переходник `tools/mcp/panel.mjs`
//     в одноразовую панель, и его результат (страница из запроса) вернулся модели;
//   - окно получило кадры start(qwen) → tool → tool-result → done.
// Дом Qwen — временный каталог (`QWEN_HOME`), настоящий `~/.qwen` не трогается.
// Нет `qwen` — «не проверено» (код 2), а не провал.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const BRIDGE_PREFIX = 'mcp__agentdeck-panel__';
const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка модели: первый запрос — вызов `where_am_i`, после результата — ответ с ним. */
function startAgentModel() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — пустой сценарий
      }
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
      const toolResult = (body.messages ?? []).find((message) => message.role === 'tool');
      const system = (body.messages ?? []).find((message) => message.role === 'system');
      requests.push({
        tools,
        system:
          typeof system?.content === 'string'
            ? system.content
            : JSON.stringify(system?.content ?? ''),
        toolResult: toolResult ? JSON.stringify(toolResult.content) : null,
      });
      const target = tools.find((name) => name === `${BRIDGE_PREFIX}where_am_i`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
      if (target && !toolResult) {
        send({
          ...head,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: target, arguments: '{}' },
                  },
                ],
              },
            },
          ],
        });
        send({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const seen = JSON.stringify(toolResult?.content ?? '').includes(ROUTE_MARK)
          ? 'ROUTE_SEEN'
          : 'ROUTE_MISSING';
        send({
          ...head,
          choices: [{ index: 0, delta: { role: 'assistant', content: `AGENT_OK ${seen}` } }],
        });
        send({
          ...head,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
      }),
    ),
  );
}

const { check, finish } = reporter();
const dir = findCli('qwen');
if (!dir) {
  console.log('Не проверено: qwen нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startAgentModel();
const root = mkdtempSync(join(tmpdir(), 'cc-agent-qwen-'));
const qwenHome = join(root, 'qwen-home');
mkdirSync(qwenHome, { recursive: true });
// Вход «как у человека»: способ входа — в настройках, ключ и адрес — переменными.
writeFileSync(
  join(qwenHome, 'settings.json'),
  JSON.stringify({ security: { auth: { selectedType: 'openai' } } }),
);
Object.assign(process.env, {
  QWEN_HOME: qwenHome,
  OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
});

let stand;
try {
  stand = await startStand({
    web: false,
    label: 'agent-qwen',
    settings: { provider: 'qwen' },
    extraPath: [dir],
  });
  const response = await fetch(`${stand.apiUrl}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: 'live-qwen-1',
      messages: [{ role: 'user', content: 'Где я сейчас?' }],
      context: { route: ROUTE_MARK, title: 'Проверка' },
    }),
  });
  const text = await response.text();
  check(
    'ход принят (200, поток)',
    response.status === 200,
    `${response.status} ${text.slice(0, 400)}`,
  );
  const frames = text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  console.log('  кадры:', JSON.stringify(frames));
  check(
    'start: провайдер qwen',
    frames[0]?.kind === 'start' && frames[0]?.providerId === 'qwen',
    JSON.stringify(frames[0]),
  );
  check(
    'кадр действия where_am_i',
    frames.some((f) => f.kind === 'tool' && f.name === 'where_am_i'),
    '',
  );
  check(
    'действие выполнено панелью без ошибки',
    frames.some((f) => f.kind === 'tool-result' && f.name === 'where_am_i' && f.isError === false),
    '',
  );
  const done = frames.at(-1);
  check(
    'ответ агента: результат действия дошёл до модели',
    done?.kind === 'done' && done.reply === 'AGENT_OK ROUTE_SEEN',
    JSON.stringify(done),
  );
  console.log(
    '  запросы модели:',
    JSON.stringify(
      stub.requests.map((r) => ({
        tools: r.tools.length,
        foreign: r.tools.filter((name) => !name.startsWith(BRIDGE_PREFIX)),
        toolResult: r.toolResult?.slice(0, 160) ?? null,
      })),
    ),
  );
  const first = stub.requests[0];
  check('модель получила запрос', Boolean(first), '');
  check(
    'модели предложены ТОЛЬКО инструменты переходника панели',
    stub.requests.length > 0 &&
      stub.requests.every(
        (r) => r.tools.length > 0 && r.tools.every((name) => name.startsWith(BRIDGE_PREFIX)),
      ),
    JSON.stringify(stub.requests.map((r) => r.tools)),
  );
  check(
    'в системном промпте — дописка агента панели',
    first?.system.includes('You are the agent of the AgentDeck panel') ?? false,
    first?.system.slice(0, 200),
  );
  check(
    'сессии человека не записаны (QWEN_HOME/projects нет)',
    !existsSync(join(qwenHome, 'projects')),
    '',
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else throw error;
} finally {
  await stand?.stop();
  await stub.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
finish();
