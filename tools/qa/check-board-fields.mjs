/**
 * Живое доказательство 5.2 плана экономии: список задач трекера доходит до
 * сервера без описаний — хук подставляет поля на настоящем `claude`.
 *
 * Юнит-тесты видят хук в профиле и выход хука из функции; вопрос же в том, что
 * сделает с ними CLI: применит ли он `updatedInput` хука PreToolUse к
 * MCP-инструменту без `permissionDecision`, получит ли брокер прав панели уже
 * исправленный вход и не заменит ли `--settings` хуки человека. Подменены
 * модель (стаб вместо API Anthropic, зовёт инструменты доски по очереди) и
 * сервер трекера (`mcp-board-stub.mjs`, пишет полученные поля эхом). Своё — всё
 * остальное: настройки строит настоящий `chatRunProfile`, хук — настоящий
 * `tools/board-fields-hook.mjs`.
 *
 * Случаи:
 * - с хуком: поиск, доска и спринт без полей доходят до сервера с коротким
 *   набором, в ответах нет описаний; поиск с названными полями доходит как
 *   был; подсказка хука доходит до модели; личный хук человека срабатывает рядом;
 * - с хуком через брокер прав (`--permission-prompt-tool`, как у панели в
 *   режиме подтверждений): брокер видит уже короткий набор, сервер — тоже;
 * - без хука: те же вызовы доходят без полей, ответы — с описаниями (проба
 *   видит то, что меряет).
 *
 * Запуск: `node tools/qa/check-board-fields.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PREFIX = 'cc-boardfields-';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const STUB = join(TOOLS, 'qa', 'mcp-board-stub.mjs');
/** Команда хука — так её собирает `runtime.ts`. */
const HOOK = `node "${join(TOOLS, 'board-fields-hook.mjs')}"`;
const EXPLICIT = 'summary,description';
/** Порядок вызовов модели-стаба: по одному инструменту на ход, потом слово. */
const CALLS = [
  ['jira_search', { jql: 'project = PROJ' }],
  ['jira_get_board_issues', { board_id: '7' }],
  ['jira_get_sprint_issues', { sprint_id: '3' }],
  ['jira_search', { jql: 'key = PROJ-1', fields: EXPLICIT }],
];

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Все `tool_result` разговора по порядку, текстом. */
function toolResults(body) {
  const results = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const content = block.content;
      results.push(
        Array.isArray(content)
          ? content.map((part) => part.text ?? '').join('')
          : String(content ?? ''),
      );
    }
  }
  return results;
}

/** Поля, которые сервер получил, — из эха в ответе. */
const receivedFields = (text) => /"received_fields":"([^"]*)"/.exec(text)?.[1] ?? '';

function sse(blocks, stop) {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_bf',
          type: 'message',
          role: 'assistant',
          model: 'stub',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach(([start, delta], index) => {
    events.push([
      'content_block_start',
      { type: 'content_block_start', index, content_block: start },
    ]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** Стаб API: в разговоре с инструментами доски зовёт их по очереди, иначе — слово. */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // пустое тело — тоже запрос
      }
      const tools = (body.tools ?? []).map((tool) => tool.name);
      const main = tools.some((name) => /__jira_get_board_issues$/.test(name));
      if (main) seen.push(body);
      const done = toolResults(body).length;
      const next = main ? CALLS[done] : undefined;
      const name = next && tools.find((tool) => tool.endsWith(`__${next[0]}`));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(
        name
          ? sse(
              [
                [
                  { type: 'tool_use', id: `toolu_bf${done}`, name, input: {} },
                  { type: 'input_json_delta', partial_json: JSON.stringify(next[1]) },
                ],
              ],
              'tool_use',
            )
          : sse(
              [
                [
                  { type: 'text', text: '' },
                  { type: 'text_delta', text: 'ok' },
                ],
              ],
              'end_turn',
            ),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => server.close(),
      }),
    ),
  );
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { chatRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const { LIST_FIELDS } = await import('../board-fields-hook.mjs');
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);
  const userHook = join(work, 'user-hook.mjs');
  writeFileSync(
    userHook,
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      "const input = JSON.parse(readFileSync(0, 'utf8'));\n" +
      "appendFileSync(process.argv[2], input.tool_name + '\\n');\n",
  );

  /** Один ход чата с инструментами доски; `broker` — права через брокер, как у панели. */
  async function run(label, { hook, broker }) {
    const dir = join(work, label);
    const home = join(dir, 'home');
    const project = join(dir, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const userLog = join(dir, 'user-hook.log');
    const permLog = join(dir, 'perm.log');
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'mcp__jira__.*',
              hooks: [{ type: 'command', command: `node "${userHook}" "${userLog}"` }],
            },
          ],
        },
      }),
    );
    const servers = { jira: { command: process.execPath, args: [STUB] } };
    if (broker) servers.perm = { command: process.execPath, args: [STUB, '--perm', permLog] };
    const mcpFile = join(dir, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }));
    const profile = hook ? chatRunProfile({ boardHook: HOOK }) : undefined;
    const settingsFile = join(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(profile?.settings ?? {}));
    const env = {
      ...process.env,
      ...profile?.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'bf-stub',
      ANTHROPIC_API_KEY: 'bf-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
    };
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(profile?.args ?? []),
      '--mcp-config',
      mcpFile,
      '--settings',
      settingsFile,
      ...(broker
        ? ['--permission-prompt-tool', 'mcp__perm__approve']
        : ['--allowedTools', 'mcp__jira']),
    ];
    const from = stub.seen.length;
    const output = await new Promise((resolve) => {
      const child = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => child.kill(), 120_000);
      const message = { role: 'user', content: 'list the board' };
      child.stdin.end(`${JSON.stringify({ type: 'user', message })}\n`);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const requests = stub.seen.slice(from);
    // Ни одного запроса с инструментами — CLI не дошёл до модели: его слова и есть причина.
    if (requests.length === 0) console.log(`[${label}] CLI:\n${output.slice(-1500)}`);
    const last = requests.at(-1) ?? {};
    return {
      results: toolResults(last),
      body: JSON.stringify(last),
      userLog: existsSync(userLog) ? readFileSync(userLog, 'utf8') : '',
      permLog: existsSync(permLog) ? readFileSync(permLog, 'utf8') : '',
    };
  }

  const listed = (results) => results.slice(0, 3);

  const hooked = await run('hook', { hook: true });
  check(
    hooked.results.length === 4,
    `с хуком: модель получила четыре ответа (${hooked.results.length})`,
  );
  check(
    listed(hooked.results).every((text) => receivedFields(text) === LIST_FIELDS),
    `поиск, доска, спринт без полей дошли с коротким набором (${listed(hooked.results).map(receivedFields).join(' | ')})`,
  );
  check(
    listed(hooked.results).every((text) => !text.includes('BOARDDESC')),
    `в ответах списка нет описаний (${listed(hooked.results)
      .map((text) => text.length)
      .join('/')} зн.)`,
  );
  const explicit = hooked.results[3] ?? '';
  check(
    receivedFields(explicit) === EXPLICIT && explicit.includes('BOARDDESC'),
    `названные поля дошли как были (${receivedFields(explicit)})`,
  );
  check(
    hooked.body.includes('Issue lists here come without descriptions'),
    'подсказка хука дошла до модели',
  );
  check(
    hooked.userLog.split('\n').filter(Boolean).length === 4,
    `личный хук человека сработал рядом на каждый вызов (${JSON.stringify(hooked.userLog.trim())})`,
  );

  const brokered = await run('broker', { hook: true, broker: true });
  const permInputs = brokered.permLog
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check(
    permInputs.length === 4 &&
      permInputs.slice(0, 3).every((input) => input.fields === LIST_FIELDS) &&
      permInputs[3]?.fields === EXPLICIT,
    `брокер прав получил уже исправленный вход (${permInputs.map((input) => input.fields ?? '(none)').join(' | ')})`,
  );
  check(
    listed(brokered.results).every((text) => receivedFields(text) === LIST_FIELDS),
    `через брокер сервер получил короткий набор (${listed(brokered.results).map(receivedFields).join(' | ')})`,
  );

  const plain = await run('no-hook', { hook: false });
  check(
    listed(plain.results).every((text) => receivedFields(text) === '(none)'),
    `без хука вызовы дошли без полей (${listed(plain.results).map(receivedFields).join(' | ')})`,
  );
  check(
    listed(plain.results).every((text) => text.includes('BOARDDESC')),
    `без хука ответы с описаниями (${listed(plain.results)
      .map((text) => text.length)
      .join('/')} зн.)`,
  );

  stub.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
