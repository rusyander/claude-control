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
 * Случаи (политика владельца 19.10: карточка — только удаление, слияние, пуш
 * в основную ветку и принудительный пуш):
 * - запись в тред MR и правка описания доходят до панели запросом прав, панель
 *   решает «с отметкой» — запись исполнена, хаб её покажет;
 * - слияние MR инструментом форджа — снято профилем (`mergeDeny`), модели не
 *   дано; дано — «человеку»; до сервера не доходит в обоих случаях;
 * - чтение MR исполняется без карточки;
 * - принудительный пуш оболочкой (`--force`, `--force-with-lease`, `-f`,
 *   `+refspec`, `git -C`, внутри составной команды) — тоже запрос прав панели
 *   с решением «человеку», ветка на удалённом не тронута (журнал 19.10 02:17:02,
 *   L7.12: группа переписала ветку MR, стоявшего на ревью, без карточки);
 * - пуш в main (в том числе `git -C`, в составной команде), удаление ветки на
 *   удалённом (`--delete`, `:ветка`) и локально, `git merge`, `rm -rf src` —
 *   «человеку», и ничего из этого не исполнено;
 * - обычный пуш рабочей ветки и `rm -rf dist` доходят до панели, решаются сами и
 *   исполнены; `git status` исполняется без карточки.
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
  ['merge_merge_request', { iid: '1018' }],
];
/** Ветка группы — та, на которой копия стоит по git. */
const OWN = 'fix/forge-ask';

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
/**
 * Опасное по политике 19.10: каждое — карточкой, и по репозиторию видно, что
 * команда не исполнилась (`intact` — проверка после прогона).
 */
const DANGER = [
  ['git push origin HEAD:main', 'main'],
  ['git -C . push origin HEAD:main', 'main'],
  ['git status --short && git push origin HEAD:main', 'main'],
  ['git push origin --delete del1', 'del1'],
  ['git push origin :del2', 'del2'],
  ['git branch -D keepme', 'keepme'],
  // Глобальный ключ перед подкомандой и другое имя git (F-28): правило `ask`
  // `Bash(* git *)` / `Bash(git *)` обязано задеть и их.
  ['git --no-pager branch -D keep2', 'keep2'],
  ['command git push origin --delete del3', 'del3'],
  ['git merge side', 'merge'],
  // `src` не отслеживается: удалить его — безвозвратно, карточка и по 23.10.
  ['rm -rf src', 'src'],
];
/**
 * Опасное инструментом PowerShell (повторная проверка 24.10): правило `Bash(…)` его
 * не задевает, и в авторежиме такие вызовы шли мимо брокера к классификатору. У
 * каждого своя цель — по ней видно, исполнилась ли команда.
 */
const PS_DANGER = [
  ['git push origin HEAD:main', 'main'],
  ['git push origin --delete del4', 'del4'],
  ['git branch -D keep3', 'keep3'],
  ['Remove-Item -Recurse -Force src', 'src'],
  ["Invoke-Expression 'git branch -D keep4'", 'keep4'],
];
/** Рутина PowerShell: доходит до панели, решается сама и исполнена. */
const PS_PLAIN_PUSH = 'git push origin HEAD:psplain';
/** Рутина: доходит до панели правилом `ask`, решается сама и исполнена. */
const PLAIN_PUSH = 'git push origin HEAD:plain';
const TEMP_CLEANUP = 'rm -rf dist';
const BASH_CALLS = [
  ...FORCE_PUSHES.map(([, command]) => command),
  ...DANGER.map(([command]) => command),
  PLAIN_PUSH,
  TEMP_CLEANUP,
  'git status --short',
];

/**
 * Порядок вызовов модели-стаба — из инструментов, которые CLI ДЕЙСТВИТЕЛЬНО дал
 * модели: сначала хранилище кода, потом оболочка. Слияние MR профиль группы
 * снимает запретом (`mergeDeny`), и инструмента в списке нет: прежде номер вызова
 * считался по полному `CALLS`, на слиянии стаб не находил инструмента и кончал
 * разговор — ни одна команда оболочки не звалась (ревью 23.10, L9).
 */
function planFor(tools) {
  const forge = CALLS.flatMap(([verb, input]) => {
    const name = tools.find((tool) => tool.endsWith(`__${verb}`));
    return name ? [{ name, input }] : [];
  });
  const powershell = tools.includes('PowerShell')
    ? [...PS_DANGER.map(([command]) => command), PS_PLAIN_PUSH].map((command) => ({
        name: 'PowerShell',
        input: { command },
      }))
    : [];
  const shell = tools.includes('Bash')
    ? BASH_CALLS.map((command) => ({ name: 'Bash', input: { command } }))
    : [];
  // `git status` оболочки — последним: по номеру его итог ищут в потоке CLI.
  return [...forge, ...powershell, ...shell];
}

/** Инструменты главного разговора по словам CLI — из последнего запроса к стабу. */
let offeredTools = [];

function callAt(index, tools) {
  return planFor(tools)[index];
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
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
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
          `[stub] main=${main} tools=${tools.length} results=${resultCount(body)} [${tools.join(',')}] ${system}`,
        );
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (!main) {
        res.end(textReply('no'));
        return;
      }
      offeredTools = tools;
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
async function startPanel(project) {
  const { groupDecision, withWorktree } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'group-permissions.ts')).href
  );
  const { resolveGroupPermissions, SPLIT_DEFAULTS_BUILTIN } = await import(
    pathToFileURL(join(TOOLS, '..', 'packages', 'contracts', 'src', 'split-groups.ts')).href
  );
  const group = {
    rows: resolveGroupPermissions(SPLIT_DEFAULTS_BUILTIN.permissions, undefined),
    allowEdits: true,
    branch: OWN,
    parentChatId: 'parent',
    groupIndex: 1,
  };
  const asked = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      // Копия и своя ветка — у git копии, как в маршруте `/api/chat/permission-request`.
      const placed = await withWorktree(group, project, body);
      const level = groupDecision(placed, {
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
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);
  const home = join(work, 'home');
  const project = join(work, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const panel = await startPanel(project);
  writeFileSync(join(home, 'settings.json'), '{}');
  const forgeLog = join(work, 'forge.log');
  // main, del1, del2 на удалённом — на коммите zero; ветка группы растёт от него,
  // так что пуш HEAD:main прошёл бы перемоткой — не исполнен он только без разрешения.
  const remote = join(work, 'remote.git');
  git(work, 'init', '-q', '--bare', remote);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'zero\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'zero');
  const zero = git(project, 'rev-parse', 'HEAD');
  git(project, 'remote', 'add', 'origin', remote);
  git(
    project,
    'push',
    '-q',
    'origin',
    'HEAD:main',
    'HEAD:del1',
    'HEAD:del2',
    'HEAD:del3',
    'HEAD:del4',
  );
  git(project, 'branch', 'keepme');
  git(project, 'branch', 'keep2');
  git(project, 'branch', 'keep3');
  git(project, 'branch', 'keep4');
  // `side` — ветка со своим коммитом: исполненный `git merge side` сдвинул бы HEAD.
  git(project, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(project, 'b.txt'), 'side\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'side');
  git(project, 'checkout', '-q', '-b', OWN, zero);
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git(project, 'commit', '-qam', 'one');
  // Ветки MR на удалённом: по ветке на случай; локальная голова переписана —
  // обычный пуш туда не пройдёт, только принудительный.
  for (const [branch] of FORCE_PUSHES) git(project, 'push', '-q', 'origin', `HEAD:${branch}`);
  const before = git(project, 'rev-parse', 'HEAD');
  writeFileSync(join(project, 'a.txt'), 'two\n');
  git(project, 'commit', '-qam', 'rewritten', '--amend');
  const head = git(project, 'rev-parse', 'HEAD');
  // Настоящий каталог и временный: первый удалять — карточка, второй — уборка.
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'keep.ts'), 'export {};\n');
  mkdirSync(join(project, 'dist'), { recursive: true });
  writeFileSync(join(project, 'dist', 'out.js'), '//\n');
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
    // CLI 2.1.310 откладывает инструменты MCP за ToolSearch, и стаб не находил главный
    // разговор по имени инструмента форджа — ни одного вызова (24.10). Загрузка
    // инструментов здесь не под проверкой: путь прав тот же.
    ENABLE_TOOL_SEARCH: 'false',
    // PowerShell без Git Bash CLI включает сам, под Git Bash — по учётной записи;
    // проверка о том, куда идут его вызовы, когда он есть.
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
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
      ask?.level === 'notify',
      `${write}: панель решила «с отметкой» (${ask?.level ?? 'нет запроса'})`,
    );
    check(executed.includes(write), `${write}: исполнено сервером`);
  }
  {
    // Слияние снято профилем (`mergeDeny`) — модели инструмент не дан вовсе; дан —
    // обязан встать карточкой. Оба исхода — без слияния на сервере.
    const merge = 'merge_merge_request';
    const offered = offeredTools.some((tool) => tool.endsWith(`__${merge}`));
    const ask = panel.asked.find((entry) => entry.tool.endsWith(`__${merge}`));
    check(
      offered ? ask?.level === 'human' : !ask,
      `${merge}: ${offered ? `«человеку» (${ask?.level ?? 'нет запроса'})` : 'снят профилем, модели не дан'}`,
    );
    check(!executed.includes(merge), `${merge}: без ответа человека до сервера не дошло`);
  }
  check(
    offeredTools.includes('Bash') &&
      offeredTools.some((tool) => tool.endsWith('__get_merge_request')),
    'модели даны оболочка и чтение MR: план вызовов не пуст',
  );
  // Одна и та же строка бывает у обоих инструментов — запрос ищется по паре.
  const askOf = (tool, command) =>
    panel.asked.find((entry) => entry.tool === tool && entry.command === command);
  for (const [command] of DANGER) {
    const ask = askOf('Bash', command);
    check(
      ask?.level === 'human',
      `${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
    );
  }
  // PowerShell под Git Bash CLI даёт по умолчанию; не дан — его случаи не проверены,
  // и это провал, а не молчаливый пропуск.
  check(
    process.platform !== 'win32' || offeredTools.includes('PowerShell'),
    'модели дан инструмент PowerShell (Windows)',
  );
  if (offeredTools.includes('PowerShell')) {
    for (const [command] of PS_DANGER) {
      const ask = askOf('PowerShell', command);
      check(
        ask?.level === 'human',
        `PowerShell ${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
      );
    }
    const ask = askOf('PowerShell', PS_PLAIN_PUSH);
    check(
      ask?.level === 'auto',
      `PowerShell ${PS_PLAIN_PUSH}: дошёл до панели и решён сам (${ask?.level ?? 'нет запроса'})`,
    );
  }
  const remoteHas = (branch) =>
    spawnSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: remote }).status === 0;
  check(git(remote, 'rev-parse', 'main') === zero, 'main на удалённом не тронута');
  check(
    remoteHas('del1') && remoteHas('del2') && remoteHas('del3') && remoteHas('del4'),
    'del1–del4 на удалённом не удалены',
  );
  for (const branch of ['keepme', 'keep2', 'keep3', 'keep4']) {
    check(git(project, 'rev-parse', '--verify', '-q', branch) === zero, `${branch} не удалена`);
  }
  check(git(project, 'rev-parse', 'HEAD') === head, 'git merge side не исполнен');
  check(existsSync(join(project, 'src', 'keep.ts')), 'src не удалён');
  if (offeredTools.includes('PowerShell')) {
    check(
      remoteHas('psplain') && git(remote, 'rev-parse', 'psplain') === head,
      `PowerShell ${PS_PLAIN_PUSH}: исполнен`,
    );
  }
  for (const command of [PLAIN_PUSH, TEMP_CLEANUP]) {
    const ask = askOf('Bash', command);
    check(
      ask?.level === 'auto',
      `${command}: дошёл до панели и решён сам (${ask?.level ?? 'нет запроса'})`,
    );
  }
  check(
    remoteHas('plain') && git(remote, 'rev-parse', 'plain') === head,
    `${PLAIN_PUSH}: исполнен`,
  );
  check(!existsSync(join(project, 'dist')), `${TEMP_CLEANUP}: исполнен`);
  for (const [branch, command] of FORCE_PUSHES) {
    const ask = askOf('Bash', command);
    check(
      ask?.level === 'human',
      `${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
    );
    const head = git(remote, 'rev-parse', branch);
    check(head === before, `${command}: ветка ${branch} на удалённом не тронута`);
  }
  const status = askOf('Bash', 'git status --short');
  check(!status || status.level === 'auto', 'git status: без карточки');
  // Итог вызова — из потока CLI: `tool_result` с номером вызова модели-стаба.
  const statusId = `toolu_fa${planFor(offeredTools).length - 1}`;
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
