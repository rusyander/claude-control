// Агент панели у OpenCode — живьём: одноразовая панель, НАСТОЯЩИЙ opencode (из
// `STEER_CLI_DIR` или PATH) и заглушка модели OpenAI chat/completions.
// Доказательство — то, что прошло по проводу и по диску:
//   - модель увидела ТОЛЬКО инструменты переходника (ни файлов, ни оболочки, ни задач);
//   - системный промпт модели — промпт агента панели, а не промпт OpenCode;
//   - ни AGENTS.md, ни скилл, ни MCP-сервер «человека» до хода не дошли;
//   - ключ взят из `auth.json` человека (в конфиге и окружении ключа нет);
//   - вызов `where_am_i` прошёл через настоящий переходник в одноразовую панель;
//   - лишнего вызова модели (заголовок разговора) нет;
//   - каталоги «человека» после хода те же, файл в файл (сессия в них не легла);
//   - картинка дошла до модели вложением.
// «Человек» — временные XDG-каталоги; настоящий `~/.config/opencode` не трогается.
// Нет `opencode` — «не проверено» (код 2), а не провал.
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
const BRIDGE_PREFIX = 'agentdeck-panel_';
const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;
const AGENTS_MARK = 'USER_OPENCODE_AGENTS_MARK_51';
const SKILL_MARK = 'USER_OPENCODE_SKILL_MARK_52';
const KEY = 'agent-check-auth-key';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка модели: объявлен `where_am_i` — вызов; после ответа инструмента — текст. */
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
        agents: raw.includes(AGENTS_MARK),
        skill: raw.includes(SKILL_MARK),
        image: raw.includes(PNG_1PX.slice(0, 40)),
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
          ? 'AGENT_OK ROUTE_SEEN'
          : 'AGENT_PLAIN';
        send({ ...head, choices: [{ index: 0, delta: { role: 'assistant', content: seen } }] });
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
const dir = findCli('opencode');
if (!dir) {
  console.log('Не проверено: opencode нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startAgentModel();
const root = mkdtempSync(join(tmpdir(), 'cc-agent-opencode-'));
const marks = join(root, 'marks');
mkdirSync(marks);
const fwd = (path) => path.replace(/\\/g, '/');
writeFileSync(
  join(root, 'mark.cjs'),
  "require('fs').writeFileSync(process.argv[2],'1');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
);
// MCP-сервер «человека» — настоящий, хоть и крошечный: молчащий сервер повесил бы
// ход на ожидании `initialize`, и утечка выглядела бы зависанием, а не провалом.
writeFileSync(
  join(root, 'mcp-mark.cjs'),
  [
    "const fs=require('fs');fs.writeFileSync(process.argv[2],'1');let buf='';",
    "process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);",
    "const reply=(r)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');",
    "if(m.method==='initialize')reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'u',version:'1'}});",
    "else if(m.method==='tools/list')reply({tools:[{name:'user_tool',description:'u',inputSchema:{type:'object',properties:{}}}]});",
    'else if(m.id!==undefined)reply({});}});',
  ].join('\n'),
);
// «Человек»: его конфиг (провайдер без ключа, MCP-сервер), AGENTS.md, скилл и ключ в auth.json.
const userConfig = join(root, 'user-config');
const userData = join(root, 'user-data');
mkdirSync(join(userConfig, 'opencode', 'skills', 'uskill'), { recursive: true });
mkdirSync(join(userData, 'opencode'), { recursive: true });
writeFileSync(
  join(userConfig, 'opencode', 'opencode.json'),
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      stub: {
        npm: '@ai-sdk/openai-compatible',
        name: 'stub',
        options: { baseURL: `http://127.0.0.1:${stub.port}/v1` },
        models: {
          'stub-model': {
            name: 'stub',
            tool_call: true,
            attachment: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    },
    model: 'stub/stub-model',
    mcp: {
      usersrv: {
        type: 'local',
        command: [process.execPath, fwd(join(root, 'mcp-mark.cjs')), fwd(join(marks, 'user-mcp'))],
        enabled: true,
      },
    },
  }),
);
writeFileSync(join(userConfig, 'opencode', 'AGENTS.md'), `${AGENTS_MARK}\n`);
writeFileSync(
  join(userConfig, 'opencode', 'skills', 'uskill', 'SKILL.md'),
  `---\nname: uskill\ndescription: ${SKILL_MARK}\n---\nbody\n`,
);
writeFileSync(
  join(userData, 'opencode', 'auth.json'),
  JSON.stringify({ stub: { type: 'api', key: KEY } }),
);
const beforeConfig = snapshot(userConfig);
const beforeData = snapshot(userData);

delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;
Object.assign(process.env, {
  XDG_CONFIG_HOME: userConfig,
  XDG_DATA_HOME: userData,
  XDG_CACHE_HOME: join(root, 'user-cache'),
  OPENCODE_DISABLE_MODELS_FETCH: '1',
});

let stand;
try {
  stand = await startStand({
    web: false,
    label: 'agent-opencode',
    settings: { provider: 'opencode' },
    extraPath: [dir],
  });

  const first = await turn(stand, 'live-opencode-1');
  check(
    'ход принят (200, поток)',
    first.status === 200,
    `${first.status} ${first.text.slice(0, 400)}`,
  );
  console.log('  кадры:', JSON.stringify(first.frames));
  check(
    'start: провайдер opencode',
    first.frames[0]?.kind === 'start' && first.frames[0]?.providerId === 'opencode',
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
        system: r.system.slice(0, 60),
      })),
    ),
  );
  check(
    'модели было ровно 2 запроса — без заголовка разговора',
    stub.requests.length === 2,
    String(stub.requests.length),
  );
  check(
    'модели объявлены ТОЛЬКО инструменты переходника панели',
    stub.requests.length > 0 &&
      stub.requests.every(
        (r) => r.tools.length > 0 && r.tools.every((name) => name.startsWith(BRIDGE_PREFIX)),
      ),
    JSON.stringify(
      stub.requests.map((r) => r.tools.filter((name) => !name.startsWith(BRIDGE_PREFIX))),
    ),
  );
  check(
    'системный промпт — агента панели',
    stub.requests[0]?.system.startsWith('You are the agent of the AgentDeck panel') ?? false,
    stub.requests[0]?.system.slice(0, 200),
  );
  check(
    'ключ — из auth.json человека',
    stub.requests.length > 0 && stub.requests.every((r) => r.auth === `Bearer ${KEY}`),
    stub.requests[0]?.auth,
  );
  check(
    'AGENTS.md человека до модели не дошёл',
    stub.requests.length > 0 && stub.requests.every((r) => !r.agents),
    '',
  );
  check(
    'скилл человека до модели не дошёл',
    stub.requests.length > 0 && stub.requests.every((r) => !r.skill),
    '',
  );
  check('MCP-сервер человека не запускался', !existsSync(join(marks, 'user-mcp')), '');
  check(
    'каталоги человека после хода те же, файл в файл',
    JSON.stringify(snapshot(userConfig)) === JSON.stringify(beforeConfig) &&
      JSON.stringify(snapshot(userData)) === JSON.stringify(beforeData),
    JSON.stringify({ config: snapshot(userConfig), data: snapshot(userData) }),
  );

  const callsBefore = stub.requests.length;
  const withImage = await turn(stand, 'live-opencode-image', {
    images: [{ name: 'dot.png', mediaType: 'image/png', base64: PNG_1PX }],
  });
  const imageRequests = stub.requests.slice(callsBefore);
  check(
    'ход с картинкой дошёл до ответа',
    withImage.frames.at(-1)?.kind === 'done',
    JSON.stringify(withImage.frames),
  );
  check(
    'картинка дошла до модели вложением',
    imageRequests.some((r) => r.image),
    String(imageRequests.length),
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
