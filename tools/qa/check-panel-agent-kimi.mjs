// Агент панели у Kimi Code — живьём: одноразовая панель, НАСТОЯЩИЙ kimi (из
// `STEER_CLI_DIR` или PATH) и заглушка модели OpenAI chat/completions.
// Доказательство — то, что прошло по проводу и по диску:
//   - модель увидела ТОЛЬКО инструменты переходника (ни Bash, ни Read, ни Agent,
//     ни Skill, ни MCP-сервер «человека»);
//   - системный промпт модели — промпт агента панели дословно, без промпта Kimi
//     и без AGENTS.md человека, а `${cwd}` в реплике человека не подставлен;
//   - ни скиллы (`~/.kimi-code/skills`, `~/.agents/skills`), ни хук `[[hooks]]`
//     человека до хода не дошли;
//   - модель и ключ — из `config.toml` человека (в окружении ключа нет);
//   - реплика с кавычками, `%` и переводом строки дошла до модели как есть;
//   - прежние реплики — в системной части, текущая — сообщением человека;
//   - вызов `where_am_i` прошёл через настоящий переходник в одноразовую панель;
//   - каталог «человека» после хода тот же, файл в файл (сессия, логи, доверие
//     к папке в него не легли), а его файл входа (`credentials/`) пережил уборку;
//   - ход с картинкой — честный отказ до вызова модели.
// «Человек» — `~/.kimi-code` в доме одноразового стенда; настоящий не трогается.
// Нет `kimi` — «не проверено» (код 2), а не провал.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const BRIDGE_PREFIX = 'mcp__agentdeck-panel__';
const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;
const AGENTS_MARK = 'USER_KIMI_AGENTS_MARK_17';
const SKILL_MARK = 'USER_KIMI_SKILL_MARK_17';
const AGENTS_SKILL_MARK = 'USER_AGENTS_SKILL_MARK_17';
const KEY = 'agent-check-kimi-key';
const LOGIN_FILE = '{"stub":"kimi-login-17"}';
const QUESTION = 'Где я сейчас? "кавычки" 100% ${cwd}\nвторая строка';
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

const textOf = (content) => (typeof content === 'string' ? content : JSON.stringify(content));

/**
 * Заглушка модели: объявлен `where_am_i` — вызов; после ответа инструмента —
 * текст двумя кусками. Запрос без `where_am_i` — сразу текст.
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
      const messages = body.messages ?? [];
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
      const toolResult = messages.find((message) => message.role === 'tool');
      requests.push({
        tools,
        system: messages
          .filter((message) => message.role === 'system')
          .map((message) => textOf(message.content))
          .join('\n'),
        user: messages
          .filter((message) => message.role === 'user')
          .map((message) => textOf(message.content)),
        auth: req.headers.authorization ?? '',
        marks: [AGENTS_MARK, SKILL_MARK, AGENTS_SKILL_MARK].filter((mark) => raw.includes(mark)),
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
      messages: [{ role: 'user', content: QUESTION }],
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
const dir = findCli('kimi');
if (!dir) {
  console.log('Не проверено: kimi нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startAgentModel();
const root = mkdtempSync(join(tmpdir(), 'cc-agent-kimi-'));
const marks = join(root, 'marks');
mkdirSync(marks);
const fwd = (path) => path.replace(/\\/g, '/');
// MCP-сервер «человека» — настоящий, хоть и крошечный: запуск оставляет метку.
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
// «Человек» — в доме одноразового стенда: модель с ключом, режим «ask», хук,
// MCP-сервер, AGENTS.md, скиллы в двух местах и файл входа.
let kimiHome = '';
let agentsDir = '';
let before = {};
let beforeAgents = {};
function seedHuman({ home }) {
  kimiHome = join(home, '.kimi-code');
  mkdirSync(join(kimiHome, 'skills', 'uskill'), { recursive: true });
  mkdirSync(join(kimiHome, 'credentials'), { recursive: true });
  writeFileSync(
    join(kimiHome, 'config.toml'),
    [
      'default_model = "stub"',
      'default_permission_mode = "ask"',
      '[providers.stub]',
      'type = "openai"',
      `base_url = "http://127.0.0.1:${stub.port}/v1"`,
      `api_key = "${KEY}"`,
      '[models.stub]',
      'provider = "stub"',
      'model = "stub-model"',
      'max_context_size = 128000',
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(`"${fwd(process.execPath)}" -e "require('fs').writeFileSync('${fwd(join(marks, 'user-hook'))}','1')"`)}`,
      'timeout = 5',
      '',
    ].join('\n'),
  );
  writeFileSync(join(kimiHome, 'AGENTS.md'), `${AGENTS_MARK}\n`);
  writeFileSync(
    join(kimiHome, 'skills', 'uskill', 'SKILL.md'),
    `---\nname: uskill\ndescription: ${SKILL_MARK}\n---\nbody\n`,
  );
  writeFileSync(
    join(kimiHome, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        usersrv: {
          command: process.execPath,
          args: [fwd(join(root, 'mcp-mark.cjs')), fwd(join(marks, 'user-mcp'))],
        },
      },
    }),
  );
  writeFileSync(join(kimiHome, 'credentials', 'kimi-code.json'), LOGIN_FILE);
  agentsDir = join(home, '.agents');
  mkdirSync(join(agentsDir, 'skills', 'askill'), { recursive: true });
  writeFileSync(
    join(agentsDir, 'skills', 'askill', 'SKILL.md'),
    `---\nname: askill\ndescription: ${AGENTS_SKILL_MARK}\n---\nbody\n`,
  );
  before = snapshot(kimiHome);
  beforeAgents = snapshot(agentsDir);
}

let stand;
try {
  stand = await startStand({
    web: false,
    label: 'agent-kimi',
    settings: { provider: 'kimi' },
    extraPath: [dir],
    seed: seedHuman,
    env: { KIMI_CODE_NO_AUTO_UPDATE: '1' },
  });

  const first = await turn(stand, 'live-kimi-1');
  check(
    'ход принят (200, поток)',
    first.status === 200,
    `${first.status} ${first.text.slice(0, 400)}`,
  );
  console.log('  кадры:', JSON.stringify(first.frames));
  check(
    'start: провайдер kimi',
    first.frames[0]?.kind === 'start' && first.frames[0]?.providerId === 'kimi',
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
        marks: r.marks,
      })),
    ),
  );
  const calls = stub.requests;
  check('модель получила два запроса хода', calls.length === 2, String(calls.length));
  check(
    'модели объявлены ТОЛЬКО инструменты переходника панели',
    calls.length > 0 &&
      calls.every((r) => r.tools.length > 0 && r.tools.every((n) => n.startsWith(BRIDGE_PREFIX))),
    JSON.stringify(calls.map((r) => r.tools.filter((n) => !n.startsWith(BRIDGE_PREFIX)))),
  );
  check(
    'системный промпт — агента панели, без промпта Kimi',
    calls.length > 0 &&
      calls.every(
        (r) =>
          r.system.startsWith('You are the agent of the AgentDeck panel') &&
          !r.system.includes('You are Kimi Code CLI'),
      ),
    calls[0]?.system.slice(0, 200),
  );
  check(
    'AGENTS.md и скиллы человека до модели не дошли',
    calls.length > 0 && calls.every((r) => r.marks.length === 0),
    JSON.stringify(calls.map((r) => r.marks)),
  );
  check(
    'реплика с кавычками, % и переводом строки дошла как есть, ${cwd} не подставлен',
    calls.length > 0 && calls[0].user.includes(QUESTION),
    JSON.stringify(calls[0]?.user),
  );
  check(
    'модель и ключ — из config.toml человека',
    calls.length > 0 && calls.every((r) => r.auth === `Bearer ${KEY}`),
    calls[0]?.auth,
  );
  check('MCP-сервер человека не запускался', !existsSync(join(marks, 'user-mcp')), '');
  check('хук человека не сработал', !existsSync(join(marks, 'user-hook')), '');
  check(
    'каталог человека после хода тот же, файл в файл; файл входа пережил уборку',
    JSON.stringify(snapshot(kimiHome)) === JSON.stringify(before) &&
      readFileSync(join(kimiHome, 'credentials', 'kimi-code.json'), 'utf8') === LOGIN_FILE,
    JSON.stringify(snapshot(kimiHome)),
  );
  check(
    '~/.agents человека после хода тот же',
    JSON.stringify(snapshot(agentsDir)) === JSON.stringify(beforeAgents),
    '',
  );

  // Второй ход того же разговора: панель шлёт всю переписку, Kimi — только
  // текущую реплику флагом, прежние и итог действия — в файле агента.
  const historyAt = stub.requests.length;
  const second = await turn(stand, 'live-kimi-1', {
    messages: [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: 'AGENT_OK ROUTE_SEEN' },
      { role: 'user', content: 'второй вопрос CURRENT_MARK' },
    ],
  });
  const next = stub.requests[historyAt];
  const nextSystem = (next?.system ?? '').replaceAll('⁠', '');
  check(
    'второй ход: прежние реплики и итог действия — в системной части, текущая — сообщением',
    second.frames.at(-1)?.kind === 'done' &&
      nextSystem.includes(`Human: ${QUESTION}`) &&
      nextSystem.includes('- where_am_i: ') &&
      next.user.some((text) => text.includes('второй вопрос CURRENT_MARK')) &&
      !next.user.some((text) => text.includes('Где я сейчас?')),
    JSON.stringify({ status: second.status, text: second.text.slice(0, 300), user: next?.user }),
  );
  check(
    'второй ход: ${cwd} в истории не подставлен',
    !nextSystem.includes('cc-panel-agent-') && nextSystem.includes('100% ${cwd}'),
    nextSystem.slice(-400),
  );

  const callsBefore = stub.requests.length;
  const withImage = await turn(stand, 'live-kimi-image', {
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
