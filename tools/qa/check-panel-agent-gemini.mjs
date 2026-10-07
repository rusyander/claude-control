// Агент панели у Gemini CLI — живьём: одноразовая панель, НАСТОЯЩИЙ gemini (из
// `STEER_CLI_DIR` или PATH) и заглушка модели Google (`GOOGLE_GEMINI_BASE_URL`).
// Доказательство — то, что прошло по проводу и по диску:
//   - модель увидела ТОЛЬКО инструменты переходника (ни файлов, ни оболочки, ни поиска);
//   - системный промпт модели — промпт агента панели, а не промпт CLI;
//   - ни GEMINI.md, ни скилл, ни хук, ни MCP-сервер «человека» до хода не дошли;
//   - ключ взят из `.env` человека (в окружении панели ключа нет);
//   - вызов `where_am_i` прошёл через настоящий переходник в одноразовую панель;
//   - каталог «человека» после хода тот же, файл в файл;
//   - ход с картинкой — честный отказ до запуска, модель не вызывалась.
// «Человек» — временный `GEMINI_CLI_HOME`; настоящий `~/.gemini` не трогается.
// Нет `gemini` — «не проверено» (код 2), а не провал.
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
const BRIDGE_PREFIX = 'mcp_agentdeck-panel_';
const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;
const MEMORY_MARK = 'USER_GEMINI_MEMORY_MARK_41';
const SKILL_MARK = 'USER_GEMINI_SKILL_MARK_42';
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

/** Заглушка модели Google: объявлен `where_am_i` — вызов; после ответа инструмента — текст. */
function startGoogleModel() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — пустой сценарий
      }
      const tools = (body.tools ?? [])
        .flatMap((group) => group.functionDeclarations ?? [])
        .map((fn) => fn.name);
      const answered = raw.includes('"functionResponse"');
      if (req.url.includes(':generateContent') || req.url.includes(':streamGenerateContent')) {
        requests.push({
          url: req.url.split('?')[0],
          tools,
          answered,
          system: JSON.stringify(body.systemInstruction ?? ''),
          memory: raw.includes(MEMORY_MARK),
          skill: raw.includes(SKILL_MARK),
          routeSeen: answered && raw.includes(ROUTE_MARK),
        });
      }
      const target = tools.find((name) => name === `${BRIDGE_PREFIX}where_am_i`);
      const parts =
        target && !answered
          ? [{ functionCall: { name: target, args: {} } }]
          : [
              {
                text: answered && raw.includes(ROUTE_MARK) ? 'AGENT_OK ROUTE_SEEN' : 'AGENT_PLAIN',
              },
            ];
      const payload = {
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        modelVersion: 'gemini-2.5-flash',
      };
      // `connection: close`: на win32 gemini 0.62 падает на выходе, когда модель
      // держит соединение (provider-formats §gemini) — проверка не о том.
      if (req.url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(req.url.includes(':countTokens') ? { totalTokens: 5 } : payload));
      }
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
const dir = findCli('gemini');
if (!dir) {
  console.log('Не проверено: gemini нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startGoogleModel();
const root = mkdtempSync(join(tmpdir(), 'cc-agent-gemini-'));
const marks = join(root, 'marks');
mkdirSync(marks);
const fwd = (path) => path.replace(/\\/g, '/');
// «Человек»: его MCP-сервер и хук оставляют метки, если их запустят.
writeFileSync(
  join(root, 'mark.cjs'),
  "require('fs').writeFileSync(process.argv[2],'1');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
);
const userHome = join(root, 'user-home');
const userGemini = join(userHome, '.gemini');
mkdirSync(join(userGemini, 'skills', 'uskill'), { recursive: true });
const hook = (event) => ({
  matcher: '*',
  hooks: [
    {
      type: 'command',
      // Оболочка хуков gemini на Windows — PowerShell: путь в кавычках зовётся через `&`.
      command: `${IS_WIN ? '& ' : ''}"${fwd(process.execPath)}" "${fwd(join(root, 'mark.cjs'))}" "${fwd(join(marks, `hook-${event}`))}"`,
    },
  ],
});
writeFileSync(
  join(userGemini, 'settings.json'),
  JSON.stringify(
    {
      security: { auth: { selectedType: 'gemini-api-key' } },
      model: { name: 'gemini-2.5-flash' },
      general: { disableAutoUpdate: true, disableUpdateNag: true },
      privacy: { usageStatisticsEnabled: false },
      mcpServers: {
        usersrv: {
          command: process.execPath,
          args: [fwd(join(root, 'mark.cjs')), fwd(join(marks, 'user-mcp'))],
        },
      },
      hooks: { SessionStart: [hook('SessionStart')], BeforeModel: [hook('BeforeModel')] },
    },
    null,
    2,
  ),
);
writeFileSync(join(userGemini, 'GEMINI.md'), `${MEMORY_MARK}\n`);
writeFileSync(
  join(userGemini, 'skills', 'uskill', 'SKILL.md'),
  `---\nname: uskill\ndescription: ${SKILL_MARK}\n---\nbody\n`,
);
// Ключ — только в `.env` «человека»: в окружении панели его нет.
writeFileSync(join(userGemini, '.env'), 'GEMINI_API_KEY=agent-check-key\n');
const before = snapshot(userHome);

delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
Object.assign(process.env, {
  GEMINI_CLI_HOME: userHome,
  GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${stub.port}`,
});

let stand;
try {
  stand = await startStand({
    web: false,
    label: 'agent-gemini',
    settings: { provider: 'gemini' },
    extraPath: [dir],
  });

  const first = await turn(stand, 'live-gemini-1');
  check(
    'ход принят (200, поток)',
    first.status === 200,
    `${first.status} ${first.text.slice(0, 400)}`,
  );
  console.log('  кадры:', JSON.stringify(first.frames));
  check(
    'start: провайдер gemini',
    first.frames[0]?.kind === 'start' && first.frames[0]?.providerId === 'gemini',
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
        answered: r.answered,
      })),
    ),
  );
  const asked = stub.requests.filter((r) => r.tools.length > 0);
  check('модель получила запрос с инструментами', asked.length > 0, '');
  check(
    'модели объявлены ТОЛЬКО инструменты переходника панели',
    asked.length > 0 && asked.every((r) => r.tools.every((name) => name.startsWith(BRIDGE_PREFIX))),
    JSON.stringify(asked.map((r) => r.tools)),
  );
  check(
    'системный промпт — агента панели',
    asked[0]?.system.includes('You are the agent of the AgentDeck panel') ?? false,
    asked[0]?.system.slice(0, 200),
  );
  check(
    'GEMINI.md человека до модели не дошёл',
    stub.requests.length > 0 && stub.requests.every((r) => !r.memory),
    '',
  );
  check(
    'скилл человека до модели не дошёл',
    stub.requests.length > 0 && stub.requests.every((r) => !r.skill),
    '',
  );
  check(
    'хуки человека не запускались',
    !existsSync(join(marks, 'hook-SessionStart')) && !existsSync(join(marks, 'hook-BeforeModel')),
    '',
  );
  check('MCP-сервер человека не запускался', !existsSync(join(marks, 'user-mcp')), '');
  const after = snapshot(userHome);
  check(
    'каталог человека после хода тот же, файл в файл',
    JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ before, after }),
  );

  const callsBefore = stub.requests.length;
  const withImage = await turn(stand, 'live-gemini-image', {
    images: [{ name: 'dot.png', mediaType: 'image/png', base64: PNG_1PX }],
  });
  const last = withImage.frames.at(-1);
  check(
    'ход с картинкой: честный отказ',
    last?.kind === 'error' && /картинк/i.test(last.message ?? ''),
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
