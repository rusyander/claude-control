// Агент панели у Goose — живьём: одноразовая панель, НАСТОЯЩИЙ goose (из
// `STEER_CLI_DIR` или PATH) и заглушка модели OpenAI chat/completions.
// Доказательство — то, что прошло по проводу и по диску:
//   - модель увидела ТОЛЬКО инструменты переходника (ни developer, ни todo, ни
//     load_skill, ни extensionmanager — платформенные расширения Goose сняты);
//   - системный промпт модели — промпт агента панели, а не промпт Goose;
//   - ни подсказки `.goosehints`, ни MCP-сервер «человека» до хода не дошли;
//   - ключ взят из `secrets.yaml` человека (в окружении ключа нет);
//   - `smart_approve` человека не уронил ход без терминала;
//   - вызов `where_am_i` прошёл через настоящий переходник в одноразовую панель;
//   - каталог «человека» после хода тот же, файл в файл (сессия и логи в него не легли);
//   - ход с картинкой — честный отказ до вызова модели.
// «Человек» — временный `%APPDATA%\Block\goose\config`; настоящий не трогается.
// Скилл человека (`~/.agents/skills`) здесь не сажается: Goose берёт домашний
// каталог не из USERPROFILE, и посадка значила бы запись в настоящий дом. Его
// отсутствие доказывает список инструментов: без `load_skill` скилл не загрузить.
// Нет `goose` — «не проверено» (код 2), а не провал. Только Windows: на других
// системах каталог Goose — от домашнего каталога, который здесь не подменить.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const BRIDGE_PREFIX = 'agentdeck-panel__';
const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;
const HINTS_MARK = 'USER_GOOSE_HINTS_MARK_61';
const KEY = 'agent-check-goose-secret';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function findCli(name) {
  const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * Заглушка модели: объявлен `where_am_i` — вызов; после ответа инструмента —
 * текст двумя кусками (Goose шлёт каждый кусок своей строкой). Запрос без
 * инструментов — заголовок разговора, который Goose просит сам.
 */
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
      const system = (body.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n');
      requests.push({
        tools,
        system,
        auth: req.headers.authorization ?? '',
        hints: raw.includes(HINTS_MARK),
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
          : 'PLAIN';
        send({
          ...head,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'AGENT_OK ' } }],
        });
        send({ ...head, choices: [{ index: 0, delta: { content: seen } }] });
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

/** Снимок каталога: относительный путь → размер и время правки. */
function snapshot(dir) {
  const out = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else out[relative(dir, full)] = `${info.size}:${info.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

async function turn(stand, conversationId, extra = {}) {
  const response = await fetch(`${stand.apiUrl}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      messages: [{ role: 'user', content: 'Где я сейчас?' }],
      context: { route: ROUTE_MARK, title: 'Проверка' },
      ...extra,
    }),
  });
  const text = await response.text();
  const frames = text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  return { status: response.status, text, frames };
}

const { check, finish } = reporter();
if (!IS_WIN) {
  console.log('Не проверено: каталог Goose вне Windows — от домашнего каталога, его не подменить.');
  process.exit(2);
}
const dir = findCli('goose');
if (!dir) {
  console.log('Не проверено: goose нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startAgentModel();
const root = mkdtempSync(join(tmpdir(), 'cc-agent-goose-'));
const marks = join(root, 'marks');
mkdirSync(marks);
const fwd = (path) => path.replace(/\\/g, '/');
// MCP-сервер «человека» — настоящий, хоть и крошечный. Goose 1.53 начинает с
// `server/discover`: незнакомый метод — ошибка JSON-RPC, иначе сервер не встанет
// и утечка выглядела бы его падением, а не провалом.
writeFileSync(
  join(root, 'mcp-mark.cjs'),
  [
    "const fs=require('fs');fs.writeFileSync(process.argv[2],'1');let buf='';",
    "process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);",
    "const send=(o)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...o})+'\\n');",
    "if(m.method==='initialize')send({result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'u',version:'1'}}});",
    "else if(m.method==='tools/list')send({result:{tools:[{name:'user_tool',description:'u',inputSchema:{type:'object',properties:{}}}]}});",
    "else if(m.method==='ping')send({result:{}});",
    "else if(m.id!==undefined)send({error:{code:-32601,message:'Method not found'}});}});",
  ].join('\n'),
);
// «Человек» — в доме одноразового стенда: его config.yaml (провайдер,
// smart_approve, MCP-сервер, developer), глобальные подсказки и ключ в
// secrets.yaml (связка ключей выключена — ключ живёт только в файле).
let gooseDir = '';
let userConfig = '';
let beforeConfig = {};
function seedHuman({ home }) {
  gooseDir = join(home, 'AppData', 'Roaming', 'Block', 'goose');
  userConfig = join(gooseDir, 'config');
  mkdirSync(userConfig, { recursive: true });
  writeFileSync(
    join(userConfig, 'config.yaml'),
    [
      'GOOSE_PROVIDER: openai',
      'GOOSE_MODEL: stub-model',
      `OPENAI_HOST: http://127.0.0.1:${stub.port}`,
      'GOOSE_MODE: smart_approve',
      'extensions:',
      '  usersrv:',
      '    type: stdio',
      '    name: usersrv',
      `    cmd: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(fwd(join(root, 'mcp-mark.cjs')))}, ${JSON.stringify(fwd(join(marks, 'user-mcp')))}]`,
      '    enabled: true',
      '    timeout: 300',
      '  developer:',
      '    type: builtin',
      '    name: developer',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  writeFileSync(join(userConfig, '.goosehints'), `${HINTS_MARK}\n`);
  writeFileSync(join(userConfig, 'secrets.yaml'), `OPENAI_API_KEY: ${KEY}\n`);
  beforeConfig = snapshot(userConfig);
}

let stand;
try {
  stand = await startStand({
    web: false,
    label: 'agent-goose',
    settings: { provider: 'goose' },
    extraPath: [dir],
    seed: seedHuman,
    env: { GOOSE_DISABLE_KEYRING: '1' },
  });

  const first = await turn(stand, 'live-goose-1');
  check(
    'ход принят (200, поток)',
    first.status === 200,
    `${first.status} ${first.text.slice(0, 400)}`,
  );
  console.log('  кадры:', JSON.stringify(first.frames));
  check(
    'start: провайдер goose',
    first.frames[0]?.kind === 'start' && first.frames[0]?.providerId === 'goose',
    JSON.stringify(first.frames[0]),
  );
  check(
    'кадр действия where_am_i',
    first.frames.some((f) => f.kind === 'tool' && f.name === 'where_am_i'),
    '',
  );
  check(
    'действие выполнено панелью без ошибки',
    first.frames.some(
      (f) => f.kind === 'tool-result' && f.name === 'where_am_i' && f.isError === false,
    ),
    '',
  );
  const done = first.frames.at(-1);
  check(
    'ответ агента: результат действия дошёл до модели, куски — одним текстом',
    done?.kind === 'done' && done.reply === 'AGENT_OK ROUTE_SEEN',
    JSON.stringify(done),
  );
  console.log(
    '  запросы модели:',
    JSON.stringify(
      stub.requests.map((r) => ({
        tools: r.tools.length,
        foreign: r.tools.filter((name) => !name.startsWith(BRIDGE_PREFIX)),
        system: r.system.slice(0, 60),
      })),
    ),
  );
  const agentCalls = stub.requests.filter((r) => r.tools.length > 0);
  check('модель получила запросы хода с инструментами', agentCalls.length === 2, '');
  check(
    'модели объявлены ТОЛЬКО инструменты переходника панели',
    agentCalls.length > 0 &&
      stub.requests.every((r) => r.tools.every((name) => name.startsWith(BRIDGE_PREFIX))),
    JSON.stringify(
      stub.requests.map((r) => r.tools.filter((name) => !name.startsWith(BRIDGE_PREFIX))),
    ),
  );
  check(
    'системный промпт хода — агента панели',
    agentCalls.length > 0 &&
      agentCalls.every((r) => r.system.startsWith('You are the agent of the AgentDeck panel')),
    agentCalls[0]?.system.slice(0, 200),
  );
  check(
    'ключ — из secrets.yaml человека',
    stub.requests.length > 0 && stub.requests.every((r) => r.auth === `Bearer ${KEY}`),
    stub.requests[0]?.auth,
  );
  check(
    'подсказки .goosehints человека до модели не дошли',
    stub.requests.length > 0 && stub.requests.every((r) => !r.hints),
    '',
  );
  check('MCP-сервер человека не запускался', !existsSync(join(marks, 'user-mcp')), '');
  check(
    'каталог человека после хода тот же, файл в файл',
    JSON.stringify(snapshot(userConfig)) === JSON.stringify(beforeConfig),
    JSON.stringify(snapshot(userConfig)),
  );
  check(
    'рядом с конфигом человека не появились данные Goose',
    !existsSync(join(gooseDir, 'data')),
    '',
  );

  const callsBefore = stub.requests.length;
  const withImage = await turn(stand, 'live-goose-image', {
    images: [{ name: 'dot.png', mediaType: 'image/png', base64: PNG_1PX }],
  });
  check(
    'ход с картинкой: честный отказ',
    withImage.frames.some((f) => f.kind === 'error' && /картинки/.test(f.message ?? '')),
    JSON.stringify(withImage.frames),
  );
  check(
    'ход с картинкой: модель не вызывалась',
    stub.requests.length === callsBefore,
    String(stub.requests.length - callsBefore),
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
