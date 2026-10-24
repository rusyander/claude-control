/**
 * Хуки набора в настоящих CLI, которые человек ставит вариантом руками (`variants/<cli>/`):
 * Goose и OpenCode — настоящий CLI, временный дом, модель — заглушка OpenAI `/chat/completions`.
 * Continue (`cn`) — контроль обратного: его хуки в выпуске не срабатывают, и проверка это
 * доказывает, а не верит описанию.
 *
 * Свидетель — следующий запрос к модели: в результате инструмента для `sed -i` по чужому файлу
 * стоит причина охранника набора (`inline-edit-guard`), а безобидный `echo` дошёл до оболочки и
 * вернул свою метку (иначе «отказ» мог быть поломкой всего инструмента). И журнал сессии набора
 * (`AGENTDECK_KIT_STATE`) записал промпт — хук промпта тоже исполнился.
 *
 * Подменены только модель (сеть) и дом CLI. Набор — копия встроенного с наложенным вариантом, в
 * каталоге проекта (`.agents/plugins/` у Goose; у OpenCode прослойка в
 * `.opencode/plugins/`, набор — AGENTDECK_KIT_DIR): настоящие
 * `~/.agents`, `~/.config/opencode`, `~/.continue` и `~/.claude` не пишутся — их снимок до и после
 * сравнивается. Цель `sed` — несуществующий путь вне временных папок: охранник временные пропускает,
 * а если бы он промолчал, `sed` упал бы, ничего не тронув.
 *
 * CLI ищутся в `STEER_CLI_DIR`, потом в PATH; нет CLI — его раздел «не проверено». Goose на Windows
 * зовёт хуки через `sh -c`: нет `sh` в PATH — «не проверено».
 * Код выхода: 0 — сходится, 1 — провал, 2 — ни один CLI не проверен.
 *
 * Запуск: node tools/qa/check-kit-variant-live.mjs [goose] [opencode] [continue]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findCli } from './foreign-cli.mjs';
import {
  REAL_HOME,
  REPO,
  diffRealProviderDirs,
  realProviderDirs,
  reporter,
  snapshotRealProviderDirs,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const KIT = join(REPO, 'apps', 'server', 'assets', 'kit', 'agentdeck-kit');
const VARIANTS = join(REPO, 'apps', 'server', 'assets', 'kit', 'variants');
const TOKEN = Math.random().toString(36).slice(2, 8);
const MARK = `QA-KIT-${TOKEN}`;
const ECHO = `KIT_ECHO_${TOKEN}`;
/** Чужой файл вне временных папок; его нет — `sed` без охранника упал бы, ничего не тронув. */
const TARGET = IS_WIN ? 'C:/agentdeck-qa-absent/x.ts' : '/agentdeck-qa-absent/x.ts';
const SED = `sed -i 's/a/b/' ${TARGET}`;
const GUARD = 'inline-edit-guard';

const wanted = process.argv.slice(2);
const want = (name) => wanted.length === 0 || wanted.includes(name);
const { check, failed } = reporter();
let checked = 0;

/**
 * Заглушка OpenAI `/chat/completions` (поток SSE или JSON). На запрос с меткой: без результатов
 * инструмента — вызов оболочки с `sed -i`, после одного — `echo`, дальше — текст. Служебные
 * запросы CLI (имя сессии, заголовок) метки не несут и получают текст.
 */
function startStub(shellName) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // не JSON — пустой запрос
      }
      const tools = (parsed.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
      const results = (parsed.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const marked = body.includes(MARK);
      const shell = shellName(tools);
      const command = !marked || !shell ? null : [SED, `echo ${ECHO}`][results.length];
      requests.push({ tools, results, marked, command });
      const id = `call_${requests.length}`;
      const message = command
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  name: shell,
                  arguments: JSON.stringify({ command, description: 'qa' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: `STUB_DONE_${TOKEN}` };
      const finish = command ? 'tool_calls' : 'stop';
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'stub',
            object: 'chat.completion',
            created: 1,
            model: 'stub-model',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, reason = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'stub',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'stub-model',
            choices: [{ index: 0, delta, finish_reason: reason }],
          })}\n\n`,
        );
      if (command)
        chunk({
          role: 'assistant',
          tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
        });
      else chunk({ role: 'assistant', content: message.content });
      chunk({}, finish);
      res.write(
        `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      }),
    ),
  );
}

/** Запуск CLI с таймаутом; дерево процессов снимается целиком (иначе CLI переживёт проверку). */
function run(file, args, { cwd, env, timeout = 120_000 }) {
  return new Promise((done) => {
    // PWD — тоже: OpenCode берёт каталог сессии из него, а не из cwd процесса, и без этого
    // работал бы в каталоге, откуда запущена проверка (живая проба 24.10).
    // Обёртку `.cmd` запускает cmd.exe, а он режет аргументы по пробелам — промпт кавычится.
    const viaCmd = IS_WIN && /\.cmd$/i.test(file);
    const argv = viaCmd ? args.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : args;
    const child = spawn(viaCmd ? `"${file}"` : file, argv, {
      cwd,
      env: { ...env, PWD: cwd },
      windowsHide: true,
      shell: viaCmd,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

/** Временный дом: все переменные дома указывают внутрь, модель — заглушка. */
function homeEnv(home, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AGENTDECK_|CLAUDE_|ANTHROPIC_|OPENAI_|GOOSE_|OPENCODE_|CONTINUE_)/i.test(key))
      delete env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    AGENTDECK_KIT_STATE: join(home, 'kit-state'),
    ...extra,
  };
}

/** Копия набора с наложенным вариантом CLI — то, что человек кладёт руками по README варианта. */
function kitCopy(target, variant) {
  cpSync(KIT, target, { recursive: true });
  cpSync(join(VARIANTS, variant), target, { recursive: true });
  return target;
}

/** Промпты, которые хук промпта записал в журнал сессии набора. */
function loggedPrompts(stateDir) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (readFileSync(path, 'utf8').includes(MARK)) found.push(path);
    }
  };
  walk(stateDir);
  return found;
}

/** Общая часть свидетельства: отказ с причиной охранника, `echo` исполнен, промпт в журнале. */
function verdicts(cli, stub, stateDir, out) {
  const marked = stub.requests.filter((r) => r.marked);
  const after = marked.find((r) => r.results.length >= 1);
  const second = marked.find((r) => r.results.length >= 2);
  check(
    `${cli}: модель получила вызов оболочки`,
    marked.some((r) => r.command === SED),
    out.slice(-1500),
  );
  check(
    `${cli}: sed -i по чужому файлу — в результате причина ${GUARD}`,
    Boolean(after?.results[0]?.includes(GUARD)),
    String(after?.results[0] ?? out.slice(-1500)).slice(0, 600),
  );
  check(
    `${cli}: echo пропущен и исполнен — инструмент жив`,
    Boolean(second?.results[1]?.includes(ECHO)) && !second?.results[1]?.includes(GUARD),
    String(second?.results[1] ?? '(нет второго результата)').slice(0, 600),
  );
  check(
    `${cli}: хук промпта записал промпт в журнал набора`,
    loggedPrompts(stateDir).length > 0,
    stateDir,
  );
}

const pathWith = (dir) => [dir, process.env.PATH ?? process.env.Path ?? ''].join(delimiter);

async function goose(root) {
  console.log('\nGoose — плагин `.agents/plugins/agentdeck-kit` (variants/goose)');
  const dir = findCli('goose');
  if (!dir) return console.log('  Не проверено: goose не найден');
  if (IS_WIN && !findCli('sh'))
    return console.log('  Не проверено: Goose зовёт хуки через `sh -c`, а `sh` нет в PATH');
  const home = join(root, 'goose-home');
  const project = join(root, 'goose-project');
  mkdirSync(join(project, '.agents', 'plugins'), { recursive: true });
  kitCopy(join(project, '.agents', 'plugins', 'agentdeck-kit'), 'goose');
  const stub = await startStub((tools) => tools.find((n) => /(^|__)shell$/.test(n)));
  try {
    const exe = join(dir, IS_WIN ? 'goose.exe' : 'goose');
    const res = await run(
      exe,
      ['run', '--no-session', '-q', '--max-turns', '6', '-t', `Run the check. ${MARK}`],
      {
        cwd: project,
        env: homeEnv(home, {
          PATH: pathWith(dir),
          GOOSE_PROVIDER: 'openai',
          GOOSE_MODEL: 'stub-model',
          OPENAI_HOST: `http://127.0.0.1:${stub.port}`,
          OPENAI_BASE_PATH: 'v1/chat/completions',
          OPENAI_API_KEY: 'x',
          GOOSE_MODE: 'auto',
          GOOSE_DISABLE_KEYRING: '1',
          GOOSE_TELEMETRY_ENABLED: 'false',
        }),
      },
    );
    checked += 1;
    verdicts('goose', stub, join(home, 'kit-state'), res.out);
    return { stub, res };
  } finally {
    await stub.close();
  }
}

async function opencode(root) {
  console.log(
    '\nOpenCode — прослойка в `.opencode/plugins/` проекта, AGENTDECK_KIT_DIR (variants/opencode)',
  );
  const dir = findCli('opencode');
  if (!dir) return console.log('  Не проверено: opencode не найден');
  const home = join(root, 'opencode-home');
  const project = join(root, 'opencode-project');
  // Прослойка — в `.opencode/plugins/` проекта, набор — отдельной копией (AGENTDECK_KIT_DIR):
  // OPENCODE_CONFIG_DIR на сам набор OpenCode не запускает — он читает его `agents/*.md` как свои.
  const plugins = join(project, '.opencode', 'plugins');
  mkdirSync(plugins, { recursive: true });
  const kit = kitCopy(join(root, 'opencode-kit'), 'opencode');
  cpSync(
    join(VARIANTS, 'opencode', 'plugins', 'agentdeck-kit.js'),
    join(plugins, 'agentdeck-kit.js'),
  );
  const stub = await startStub((tools) => tools.find((n) => n === 'bash'));
  try {
    const config = join(root, 'opencode.json');
    writeFileSync(
      config,
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          stub: {
            npm: '@ai-sdk/openai-compatible',
            name: 'stub',
            options: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'x' },
            models: { 'stub-model': { name: 'stub', tool_call: true } },
          },
        },
        model: 'stub/stub-model',
        small_model: 'stub/stub-model',
      }),
    );
    const exe = join(dir, IS_WIN ? 'opencode.cmd' : 'opencode');
    const res = await run(
      existsSync(exe) ? exe : join(dir, 'opencode'),
      ['run', '--auto', `Run the check. ${MARK}`],
      {
        cwd: project,
        env: homeEnv(home, { OPENCODE_CONFIG: config, AGENTDECK_KIT_DIR: kit }),
      },
    );
    checked += 1;
    verdicts('opencode', stub, join(home, 'kit-state'), res.out);
  } finally {
    await stub.close();
  }
}

/**
 * Continue: загрузчик хуков в духе Claude в исходниках `cn` есть (`.continue/settings.json`,
 * `.claude/settings.json`), но выпуск их не зовёт. Свидетель обратного: хуки промпта и PreToolUse
 * (набор + метка-сторож) лежат там, где `cn` их ищет, а `sed -i` исполнен без отказа и метка не
 * появилась. Контроль — та же команда метки, запущенная напрямую, метку пишет: иначе «не появилась»
 * могло значить сломанную команду.
 */
async function continueCli(root) {
  console.log('\nContinue (cn) — хуки в .continue/settings.json не срабатывают');
  const dir = findCli('cn');
  if (!dir) return console.log('  Не проверено: cn не найден');
  const home = join(root, 'cn-home');
  const project = join(root, 'cn-project');
  const kit = kitCopy(join(root, 'cn-kit'), 'codex');
  const marker = join(root, 'cn-marker.mjs');
  const fired = join(root, 'cn-fired.txt');
  writeFileSync(
    marker,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(fired)}, process.argv[2] + '\\n');\n`,
  );
  const q = (p) => `"${p.replaceAll('\\', '/')}"`;
  const hook = (cmd) => ({ type: 'command', command: cmd, timeout: 20 });
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [hook(`node ${q(marker)} prompt`)] }],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            hook(`node ${q(join(kit, 'hooks', 'lib', 'run.mjs'))} pre`),
            hook(`node ${q(marker)} pre`),
          ],
        },
      ],
    },
  };
  for (const where of ['.continue', '.claude']) {
    mkdirSync(join(project, where), { recursive: true });
    writeFileSync(join(project, where, 'settings.json'), JSON.stringify(settings, null, 2));
  }
  const stub = await startStub((tools) => tools.find((n) => n === 'Bash'));
  try {
    const config = join(root, 'cn-config.yaml');
    writeFileSync(
      config,
      [
        'name: Stand',
        'version: 1.0.0',
        'schema: v1',
        'models:',
        '  - name: stub',
        '    provider: openai',
        '    model: stub-model',
        `    apiBase: http://127.0.0.1:${stub.port}/v1`,
        '    apiKey: sk-stub-not-a-key',
        '    roles:',
        '      - chat',
        '',
      ].join('\n'),
    );
    const exe = join(dir, IS_WIN ? 'cn.cmd' : 'cn');
    const res = await run(
      exe,
      ['--config', config, '--allow', 'Bash', '-p', `Run the check. ${MARK}`],
      {
        cwd: project,
        env: homeEnv(home, {}),
      },
    );
    checked += 1;
    const marked = stub.requests.filter((r) => r.marked);
    const after = marked.find((r) => r.results.length >= 1);
    check(
      'continue: модель получила вызов Bash',
      marked.some((r) => r.command === SED),
      res.out.slice(-1500),
    );
    check(
      'continue: sed -i исполнен без отказа набора — PreToolUse не сработал',
      Boolean(after) && !after.results[0].includes(GUARD),
      String(after?.results[0] ?? '(нет результата)').slice(0, 600),
    );
    check(
      'continue: метка хуков не появилась — ни промпт, ни PreToolUse',
      !existsSync(fired),
      existsSync(fired) ? readFileSync(fired, 'utf8') : '',
    );
    const control = await run(process.execPath, [marker, 'control'], {
      cwd: project,
      env: process.env,
    });
    check(
      'continue: контроль — та же команда метки напрямую пишет метку',
      control.code === 0 && existsSync(fired) && readFileSync(fired, 'utf8').includes('control'),
      control.out,
    );
  } finally {
    await stub.close();
  }
}

const sections = { goose, opencode, continue: continueCli };
// `~/.claude*` пишет живая сессия человека — снимок по нему мерил бы её, а не проверку.
const realDirs = [
  ...realProviderDirs().filter((dir) => !/[\\/]\.claude[^\\/]*$/.test(dir)),
  join(REAL_HOME, '.agents'),
  join(REAL_HOME, '.continue'),
];
const realBefore = snapshotRealProviderDirs({ dirs: realDirs });
// Длинный путь: `tmpdir()` на Windows — короткое имя (`RUSYAN~1`), а OpenCode ведёт экземпляр по
// длинному — хуки плагина, загруженного под коротким, не получают ни одного события сессии.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kit-variant-live-')));
try {
  for (const [name, section] of Object.entries(sections)) {
    if (!want(name)) continue;
    try {
      await section(root);
    } catch (error) {
      check(`${name}: прогон без сбоя`, false, String(error?.stack ?? error));
    }
  }
  const changed = diffRealProviderDirs(realBefore, snapshotRealProviderDirs({ dirs: realDirs }));
  check('настоящие каталоги CLI не изменились', changed.length === 0, changed.join('\n'));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
if (checked === 0 && failed() === 0) {
  console.log('\nНе проверено: ни одного CLI.');
  process.exit(2);
}
console.log(failed() === 0 ? '\nВсё сходится.' : `\nПровалов: ${failed()}`);
process.exit(failed() === 0 ? 0 : 1);
