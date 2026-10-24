/**
 * Живое доказательство: в авторежиме CLI (`--permission-mode auto`) одиночного
 * чата удаление данных git и слияние доходят до брокера прав панели и встают
 * карточкой, а не решаются классификатором CLI (ревью 23.10, L2).
 *
 * Что было: `gitDestroys` маршрута прав (решение владельца 23.10 — удаление
 * данных git и слияние человеку и в одиночном чате) стоял только на пути
 * брокера, а авторежим шлёт брокеру лишь задетое правилом `ask`. Правил у
 * одиночного чата не было — `git branch -D` до панели не доходил вовсе.
 *
 * Подменена только модель (стаб вместо API Anthropic: по команде оболочки на
 * ход). Своё — всё остальное: настройки строит настоящий `withChatGitAsk`, как
 * `ChatRunner`; запросы прав идут настоящим брокером
 * (`permission-prompt-server.mjs`) в заглушку панели, которая решает тем же,
 * что маршрут `/api/chat/permission-request` у одиночного чата в авторежиме:
 * `gitDestroys`, затем `shouldAutoApprove` с правилами из коробки.
 *
 * Классификатор авторежима получает от стаба «нет» — разрешить сам он не может;
 * значит исполненная команда прошла именно панелью.
 *
 * Контроль: `--control` — запуск БЕЗ `CHAT_GIT_ASK`; обязан быть красным (ни
 * одна опасная команда до панели не дошла) — иначе проверка ничего не ловит.
 *
 * Запуск: `node tools/qa/check-chat-git-ask.mjs [--control]`. Нужен
 * установленный `claude` (путь — `CLAUDE_CLI`); стенд и настройки человека не
 * трогаются. `CHAT_GIT_ASK_DEBUG=1` печатает каждый запрос к модели-стабу.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREFIX = 'cc-chatgitask-';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const SERVER_SRC = join(TOOLS, '..', 'apps', 'server', 'src');
const BROKER = join(SERVER_SRC, 'domains', 'chat', 'permission-prompt-server.mjs');
const DEBUG = process.env.CHAT_GIT_ASK_DEBUG === '1';
const CONTROL = process.argv.includes('--control');

/**
 * Опасное по решению владельца 23.10: каждое — к панели, «человеку», и по
 * репозиторию видно, что команда не исполнилась. Разные имена git и ключи
 * перед подкомандой — правило `ask` обязано задеть их все.
 */
const DANGER = [
  'git branch -D keep1',
  'git --no-pager branch -D keep2',
  'command git branch -D keep3',
  'git -C . branch -M keep4',
  'git status --short && git branch -D keep5',
  'bash -c "git branch -D keep6"',
  'git update-ref -d refs/heads/keep7',
  'git tag -d v1',
  'git push origin --delete del1',
  'git push origin :del2',
  'git merge side',
  'git stash drop',
  // Склеенные ключи и сокращения (ревью 23.10, A-21, A-22) — шаблон `-d` их не задевал.
  'git branch -qD keep8',
  'git branch -fd keep9',
  'git branch --del keep10',
  'git push -fd origin del3',
  'git tag --del v2',
];
const KEEP = ['keep1', 'keep2', 'keep3', 'keep4', 'keep5', 'keep6', 'keep7', 'keep8', 'keep9'];
/** Задетое лишь шаблоном: доходит до панели, решается само и исполнено. */
const ROUTINE = ['git log --merges --oneline', 'git log --oneline -1 --branches --date=short'];
/**
 * То же инструментом PowerShell (I-08): правило `Bash(…)` его не задевает, и
 * `gitDestroys` его не судил — `git branch -D` из PowerShell шёл классификатору.
 */
const PS_DANGER = [
  'git branch -D keep11',
  'Git.exe push origin --delete del4',
  "Invoke-Expression 'git branch -D keep12'",
  "Start-Process git -ArgumentList 'branch','-D','keep13' -Wait -NoNewWindow",
];
const PS_KEEP = ['keep11', 'keep12', 'keep13'];
const PS_ROUTINE = ['git log --merges --oneline -1'];
const CALLS = [
  ...[...DANGER, ...ROUTINE].map((command) => ({ name: 'Bash', command })),
  ...[...PS_DANGER, ...PS_ROUTINE].map((command) => ({ name: 'PowerShell', command })),
];

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
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

function resultCount(body) {
  let count = 0;
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === 'tool_result') count += 1;
  }
  return count;
}

/** Итоги вызовов из потока CLI: номер вызова → текст итога. */
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

function sse(blocks, stop) {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_cg',
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

/** Ключ первой реплики главного разговора — по нему стаб отличает его от побочных. */
const MAIN_MARK = 'chat-git-ask main conversation';
/** Инструменты, которые CLI дал главному разговору (первый его запрос). */
const offeredTools = [];

/**
 * Стаб API. Главный разговор (первая реплика с `MAIN_MARK`) зовёт оболочку по
 * очереди; любой другой запрос (заголовок, классификатор авторежима) получает
 * «no» — классификатор ничего не разрешает.
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
      const first = JSON.stringify(body.messages?.[0]?.content ?? '');
      const main = tools.includes('Bash') && first.includes(MAIN_MARK);
      if (DEBUG)
        console.log(`[stub] main=${main} tools=${tools.join(',')} results=${resultCount(body)}`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (!main) {
        res.end(textReply('no'));
        return;
      }
      if (offeredTools.length === 0) offeredTools.push(...tools);
      // Инструмента PowerShell не дали — его вызовы не шлём, проверка скажет об этом.
      const calls = CALLS.filter((call) => tools.includes(call.name));
      const done = resultCount(body);
      const call = calls[done];
      res.end(
        call
          ? sse(
              [
                [
                  { type: 'tool_use', id: `toolu_cg${done}`, name: call.name, input: {} },
                  {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify({ command: call.command }),
                  },
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
 * Заглушка панели: решение одиночного чата в авторежиме, как в маршруте прав —
 * удаление данных git и слияние человеку, прочее правилами чата из коробки.
 */
async function startPanel() {
  const { gitDestroys } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'group-tree-state.ts')).href
  );
  const { shouldAutoApprove } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'auto-approve', 'auto-approve.ts')).href
  );
  const { allowedPermissionRules } = await import(
    pathToFileURL(join(TOOLS, '..', 'packages', 'contracts', 'src', 'permission-rules.ts')).href
  );
  const rules = allowedPermissionRules(undefined);
  const asked = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const allow =
        !gitDestroys(body.toolName, body.input) &&
        shouldAutoApprove({
          toolName: body.toolName,
          input: body.input,
          guardedPatterns: [],
          allowEdits: true,
          allowedRules: rules,
        });
      asked.push({
        tool: body.toolName,
        command: body.input?.command,
        level: allow ? 'auto' : 'human',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          allow
            ? { behavior: 'allow', updatedInput: body.input }
            : { behavior: 'deny', message: 'card shown to the human (check stub)' },
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
  const { withChatGitAsk } = await import(
    pathToFileURL(join(SERVER_SRC, 'domains', 'chat', 'auto-approve', 'git-ask.ts')).href
  );
  const stub = await startStub();
  const panel = await startPanel();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\nКонтроль без правил: ${CONTROL}\n`);
  const home = join(work, 'home');
  const project = join(work, 'proj');
  const remote = join(work, 'remote.git');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}');
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
  for (const name of [...KEEP, 'keep10', ...PS_KEEP]) git(project, 'branch', name);
  git(project, 'tag', 'v1');
  git(project, 'tag', 'v2');
  git(project, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(project, 'b.txt'), 'side\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'side');
  git(project, 'checkout', '-q', '-b', 'work', zero);
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git(project, 'commit', '-qam', 'one');
  writeFileSync(join(project, 'a.txt'), 'stashed\n');
  git(project, 'stash', 'push', '-q', '-m', 'keep');
  const head = git(project, 'rev-parse', 'HEAD');

  // Настройки — так, как их кладёт `ChatRunner` авторежиму с брокером.
  const settings = CONTROL
    ? {}
    : withChatGitAsk(undefined, { permissionMode: 'auto', broker: true });
  const settingsFile = join(work, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(settings));
  const brokerFile = join(work, 'perm.json');
  writeFileSync(
    brokerFile,
    JSON.stringify({
      mcpServers: {
        'perm-guard': {
          command: process.execPath,
          args: [BROKER],
          env: { PERM_RUN_ID: 'chat-git-ask', PERM_BASE_URL: panel.url, PERM_PROGRESS_MS: '0' },
        },
      },
    }),
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_AUTH_TOKEN: 'cg-stub',
    ANTHROPIC_API_KEY: 'cg-stub',
    ANTHROPIC_MODEL: process.env.CHAT_GIT_ASK_MODEL || 'claude-sonnet-4-6',
    DISABLE_AUTOUPDATER: '1',
    // CLI 2.1.310 прячет инструменты MCP за поиском инструментов: брокер прав
    // тогда не в перечне, и запрос прав до панели не доходил (проверка устарела).
    ENABLE_TOOL_SEARCH: 'false',
    // Под Git Bash инструмент PowerShell CLI сам не даёт — включаем явно.
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  };
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
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
    const message = { role: 'user', content: `${MAIN_MARK}: tidy the branches` };
    child.stdin.end(`${JSON.stringify({ type: 'user', message })}\n`);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  if (DEBUG) console.log(`[cli tail]\n${output.slice(-2500)}`);
  const mode = /"permissionMode":"(\w+)"/.exec(output)?.[1] ?? 'unknown';
  console.log(`режим прав по словам CLI: ${mode}`);
  console.log(`запросы прав панели: ${JSON.stringify(panel.asked)}\n`);

  check(mode === 'auto', `CLI в авторежиме (${mode})`);
  const askOf = (tool, command) =>
    panel.asked.find((entry) => entry.tool === tool && entry.command === command);
  for (const command of DANGER) {
    const ask = askOf('Bash', command);
    check(
      ask?.level === 'human',
      `${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
    );
  }
  const powershell = offeredTools.includes('PowerShell');
  check(
    process.platform !== 'win32' || powershell,
    `модели дан инструмент PowerShell (${offeredTools.join(', ') || 'запросов не было'})`,
  );
  if (powershell) {
    for (const command of PS_DANGER) {
      const ask = askOf('PowerShell', command);
      check(
        ask?.level === 'human',
        `PowerShell ${command}: запрос прав в панели, «человеку» (${ask?.level ?? 'нет запроса'})`,
      );
    }
  }
  const has = (cwd, ref) =>
    spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd }).status === 0;
  for (const name of [...KEEP, 'keep10', ...PS_KEEP]) {
    check(has(project, `refs/heads/${name}`), `${name} не удалена`);
  }
  check(has(project, 'refs/tags/v1') && has(project, 'refs/tags/v2'), 'теги v1, v2 не удалены');
  for (const name of ['del1', 'del2', 'del3', 'del4']) {
    check(has(remote, name), `${name} на удалённом не удалена`);
  }
  check(git(project, 'rev-parse', 'HEAD') === head, 'git merge side не исполнен');
  check(git(project, 'branch', '--show-current') === 'work', 'ветка work не переименована');
  check(git(project, 'stash', 'list').includes('keep'), 'тайник не сброшен');
  const results = toolResults(output);
  const sent = CALLS.filter((call) => offeredTools.includes(call.name));
  const routine = [
    ...ROUTINE.map((command) => ({ name: 'Bash', command })),
    ...(powershell ? PS_ROUTINE.map((command) => ({ name: 'PowerShell', command })) : []),
  ];
  for (const call of routine) {
    const label = `${call.name === 'Bash' ? '' : `${call.name} `}${call.command}`;
    const ask = askOf(call.name, call.command);
    check(
      ask?.level === 'auto',
      `${label}: дошёл до панели и решён сам (${ask?.level ?? 'нет запроса'})`,
    );
    const index = sent.findIndex(
      (each) => each.name === call.name && each.command === call.command,
    );
    const result = results.get(`toolu_cg${index}`) ?? '';
    check(
      !/denied|card shown/i.test(result) && result !== '',
      `${label}: исполнен (${result.slice(0, 60)})`,
    );
  }

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
