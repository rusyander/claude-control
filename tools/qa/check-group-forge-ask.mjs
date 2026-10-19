/**
 * Живое доказательство: запись в хранилище кода или трекер из группы разделения
 * встаёт карточкой человеку, а не проходит молча (журнал 19.10, L6.2 NEW).
 *
 * Что случилось: продолжение группы в авторежиме CLI (`--permission-mode auto`)
 * ответило в двух тредах MR и переписало его описание — ни одной карточки у
 * владельца. Авторежим решал такие вызовы сам классификатором и до брокера прав
 * панели их не доводил, а строка «запись наружу» вкладки «Группы» стояла в
 * `auto` и пропустила бы их и там.
 *
 * Подменены только модель (стаб вместо API Anthropic: читает MR, отвечает в тред,
 * правит описание) и сервер хранилища кода (`mcp-forge-stub.mjs`, пишет в журнал
 * каждый исполненный вызов). Своё — всё остальное: настройки и серверы строит
 * настоящий `groupRunProfile`, запросы прав идут настоящим брокером
 * (`permission-prompt-server.mjs`) в заглушку панели, которая решает НАСТОЯЩИМ
 * `groupDecision` над строками группы из коробки — тем же путём, что маршрут
 * `/api/chat/permission-request`.
 *
 * Случаи:
 * - запись в тред MR и правка описания доходят до панели запросом прав, панель
 *   решает «человеку» (карточка), до сервера запись не доходит;
 * - чтение MR исполняется без карточки;
 * - принудительный пуш оболочкой (`--force`, `--force-with-lease`, `-f`,
 *   `+refspec`, `git -C`, внутри составной команды) — тоже запрос прав панели
 *   с решением «человеку», ветка на удалённом не тронута (журнал 19.10 02:17:02,
 *   L7.12: группа переписала ветку MR, стоявшего на ревью, без карточки);
 * - `git status` исполняется без карточки — правило не задевает обычную работу.
 *   Обычный `git push` проверка не судит: его судьба — решение владельца.
 *
 * Запуск: `node tools/qa/check-group-forge-ask.mjs`. Нужен установленный
 * `claude` (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 * `FORGE_ASK_DEBUG=1` печатает каждый запрос к модели-стабу.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREFIX = 'cc-forgeask-';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const SERVER_SRC = join(TOOLS, '..', 'apps', 'server', 'src');
const BROKER = join(SERVER_SRC, 'domains', 'chat', 'permission-prompt-server.mjs');
const DEBUG = process.env.FORGE_ASK_DEBUG === '1';
/** Порядок вызовов модели-стаба: по одному инструменту на ход, потом слово. */
const CALLS = [
  ['get_merge_request', { iid: '1018' }],
  ['create_merge_request_note', { iid: '1018', body: 'Ответ в тред' }],
  ['update_merge_request', { iid: '1018', body: 'Новое описание' }],
];

/**
 * Принудительные пуши оболочкой: ветка удалённого на каждый случай своя, и по
 * её голове видно, исполнилась ли команда. Последней — `git status`.
 */
const FORCE_PUSHES = [
  ['f1', 'git push --force-with-lease origin HEAD:f1'],
  ['f2', 'git push origin HEAD:f2 --force'],
  ['f3', 'git push -f origin HEAD:f3'],
  ['f4', 'git push origin +HEAD:f4'],
  ['f5', 'git status --short && git push --force origin HEAD:f5'],
  ['f6', 'git -C . push --force-with-lease origin HEAD:f6'],
];
/** Обычный пуш правилом `ask` не задет: его судьба — решение владельца (Door C). */
const PLAIN_PUSH = 'git push origin HEAD:plain';
const BASH_CALLS = [
  ...FORCE_PUSHES.map(([, command]) => command),
  PLAIN_PUSH,
  'git status --short',
];

/** Вызов модели-стаба по счёту: сначала хранилище кода, потом оболочка. */
function callAt(index, tools) {
  const forge = CALLS[index];
  if (forge) {
    const name = tools.find((tool) => tool.endsWith(`__${forge[0]}`));
    return name ? { name, input: forge[1] } : undefined;
  }
  const command = BASH_CALLS[index - CALLS.length];
  return command && tools.includes('Bash') ? { name: 'Bash', input: { command } } : undefined;
}

/** Итоги вызовов из потока CLI (`stream-json`): номер вызова → текст итога. */
function toolResults(output) {
  const results = new Map();
  for (const line of output.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'user' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const text =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      results.set(block.tool_use_id, text);
    }
  }
  return results;
}

/** git в каталоге проверки; падение — сразу ошибка проверки, а не тихий пропуск. */
function git(cwd, ...args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=check@example.com', '-c', 'user.name=check', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

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
  const pub = process.env.PUBLIC;
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Сколько `tool_result` уже в разговоре: столько вызовов модель-стаб сделала. */
function resultCount(body) {
  let count = 0;
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === 'tool_result') count += 1;
  }
  return count;
}

function sse(blocks, stop) {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_fa',
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

const textReply = (text) =>
  sse(
    [
      [
        { type: 'text', text: '' },
        { type: 'text_delta', text },
      ],
    ],
    'end_turn',
  );

/**
 * Стаб API. Главный разговор (в нём есть инструменты хранилища) зовёт их по
 * очереди; любой другой запрос — побочный (заголовок, классификатор авторежима)
 * — получает ответ, который ничего не разрешает: так проверка не зависит от
 * того, как классификатор читает стаб, — разрешить вызов он не может.
 */
function startStub() {
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
      const main = tools.some((name) => /__create_merge_request_note$/.test(name));
      if (DEBUG) {
        const system = JSON.stringify(body.system ?? '').slice(0, 160);
        console.log(
          `[stub] main=${main} tools=${tools.length} results=${resultCount(body)} ${system}`,
        );
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (!main) {
        res.end(textReply('no'));
        return;
      }
      const done = resultCount(body);
      const next = callAt(done, tools);
      res.end(
        next
          ? sse(
              [
                [
                  { type: 'tool_use', id: `toolu_fa${done}`, name: next.name, input: {} },
                  { type: 'input_json_delta', partial_json: JSON.stringify(next.input) },
                ],
              ],
              'tool_use',
            )
          : textReply('ok'),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

/**
 * Заглушка панели: принимает запрос брокера прав и решает его настоящим
 * `groupDecision` над строками группы из коробки. «Человеку» — запись о
 * карточке и отказ (человек в проверке не нажимает), иначе — разрешение.
 */
async function startPanel() {
  const { groupDecision } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'group-permissions.ts')).href
  );
  const { resolveGroupPermissions, SPLIT_DEFAULTS_BUILTIN } = await import(
    pathToFileURL(join(TOOLS, '..', 'packages', 'contracts', 'src', 'split-groups.ts')).href
  );
  const group = {
    rows: resolveGroupPermissions(SPLIT_DEFAULTS_BUILTIN.permissions, undefined),
    allowEdits: true,
    branch: 'fix/forge-ask',
    parentChatId: 'parent',
    groupIndex: 1,
  };
  const asked = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const level = groupDecision(group, {
        toolName: body.toolName,
        input: body.input,
        guardedPatterns: [],
      });
      asked.push({
        tool: body.toolName,
        level,
        ...(typeof body.input?.command === 'string' ? { command: body.input.command } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          level === 'human'
            ? { behavior: 'deny', message: 'card shown to the human (check stub)' }
            : { behavior: 'allow', updatedInput: body.input },
        ),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        asked,
        close: () => server.close(),
      }),
    ),
  );
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'group-profile', 'group-profile.ts')).href
  );
  const stub = await startStub();
  const panel = await startPanel();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);
  const home = join(work, 'home');
  const project = join(work, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}');
  const forgeLog = join(work, 'forge.log');
  // Ветка MR на удалённом: по ветке на случай, все на первом коммите; локальная
  // голова переписана — обычный пуш туда не пройдёт, только принудительный.
  const remote = join(work, 'remote.git');
  git(work, 'init', '-q', '--bare', remote);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'one');
  git(project, 'remote', 'add', 'origin', remote);
  for (const [branch] of FORCE_PUSHES) git(project, 'push', '-q', 'origin', `HEAD:${branch}`);
  const before = git(project, 'rev-parse', 'HEAD');
  writeFileSync(join(project, 'a.txt'), 'two\n');
  git(project, 'commit', '-qam', 'rewritten', '--amend');
  // Неотслеживаемый файл — чтобы исполненный `git status` было видно по выводу.
  writeFileSync(join(project, 'untracked.txt'), 'x\n');

  // Набор серверов и настройки — настоящим профилем группы, как их строит реестр.
  const profile = groupRunProfile({
    entries: [
      {
        id: 'gitlab',
        config: {
          command: process.execPath,
          args: [join(TOOLS, 'qa', 'mcp-forge-stub.mjs')],
          env: { FORGE_STUB_LOG: forgeLog },
        },
      },
    ],
    tasksText: '',
    extra: [],
  });
  const mcpFile = join(work, 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify(profile.mcp.config));
  const settingsFile = join(work, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(profile.settings));
  // Брокер прав — своим `--mcp-config`, как у `ChatRunner`.
  const brokerFile = join(work, 'perm.json');
  writeFileSync(
    brokerFile,
    JSON.stringify({
      mcpServers: {
        'perm-guard': {
          command: process.execPath,
          args: [BROKER],
          env: { PERM_RUN_ID: 'forge-ask', PERM_BASE_URL: panel.url, PERM_PROGRESS_MS: '0' },
        },
      },
    }),
  );
  const env = {
    ...process.env,
    ...profile.env,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_AUTH_TOKEN: 'fa-stub',
    ANTHROPIC_API_KEY: 'fa-stub',
    ANTHROPIC_MODEL: process.env.FORGE_ASK_MODEL || 'claude-sonnet-4-6',
    DISABLE_AUTOUPDATER: '1',
  };
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Режим, в котором группа шла 19.10 (`AUTONOMOUS_PERMISSION_MODE`).
    '--permission-mode',
    'auto',
    ...profile.args,
    '--mcp-config',
    mcpFile,
    '--settings',
    settingsFile,
    '--mcp-config',
    brokerFile,
    '--permission-prompt-tool',
    'mcp__perm-guard__approve',
  ];
  const output = await new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill(), 180_000);
    const message = {
      role: 'user',
      content: 'answer the MR 1018 threads and update its description',
    };
    child.stdin.end(`${JSON.stringify({ type: 'user', message })}\n`);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  const executed = existsSync(forgeLog)
    ? readFileSync(forgeLog, 'utf8').split('\n').filter(Boolean)
    : [];
  if (DEBUG) console.log(`[cli tail]\n${output.slice(-2500)}`);
  // Весь поток CLI в файл — разбирать, чем кончился каждый вызов.
  if (process.env.FORGE_ASK_OUT) writeFileSync(process.env.FORGE_ASK_OUT, output);
  // Режим, который CLI сам объявил в начале прогона: при стабе вместо API
  // авторежим может опуститься до `default` — проверка говорит об этом вслух.
  const mode = /"permissionMode":"(\w+)"/.exec(output)?.[1] ?? 'unknown';
  console.log(`режим прав по словам CLI: ${mode}`);
  console.log(`исполнено сервером: ${JSON.stringify(executed)}`);
  console.log(`запросы прав панели: ${JSON.stringify(panel.asked)}\n`);

  // Без авторежима проверка проверяла бы другой путь: в `default` запрос прав
  // идёт в панель и без правила `ask` (так выглядел красный прогон на 4-5).
  check(mode === 'auto', `CLI в авторежиме, как группа 19.10 (${mode})`);
  check(executed.includes('get_merge_request'), 'чтение MR исполнено');
  const readAsk = panel.asked.find((ask) => ask.tool.endsWith('__get_merge_request'));
  check(!readAsk || readAsk.level === 'auto', 'чтение MR прошло без карточки');
  for (const write of ['create_merge_request_note', 'update_merge_request']) {
    const ask = panel.asked.find((entry) => entry.tool.endsWith(`__${write}`));
    check(Boolean(ask), `${write}: запрос прав дошёл до панели`);
    check(
      ask?.level === 'human',
      `${write}: панель решила «человеку» (${ask?.level ?? 'нет запроса'})`,
    );
    check(!executed.includes(write), `${write}: без ответа человека до сервера не дошло`);
  }
  for (const [branch, command] of FORCE_PUSHES) {
    const ask = panel.asked.find((entry) => entry.command === command);
    check(
      ask?.level === 'human',
      `${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
    );
    const head = git(remote, 'rev-parse', branch);
    check(head === before, `${command}: ветка ${branch} на удалённом не тронута`);
  }
  const status = panel.asked.find((entry) => entry.command === 'git status --short');
  check(!status || status.level === 'auto', 'git status: без карточки');
  // Итог вызова — из потока CLI: `tool_result` с номером вызова модели-стаба.
  const statusId = `toolu_fa${CALLS.length + BASH_CALLS.length - 1}`;
  // Обычный пуш правилом `ask` к панели не идёт: решает режим CLI, как до L7.12.
  check(
    !panel.asked.some((entry) => entry.command === PLAIN_PUSH),
    `${PLAIN_PUSH}: правилом ask не задет`,
  );
  const statusResult = toolResults(output).get(statusId) ?? '';
  check(
    statusResult.includes('untracked.txt'),
    `git status исполнен (${statusResult.slice(0, 80)})`,
  );

  stub.close();
  panel.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
