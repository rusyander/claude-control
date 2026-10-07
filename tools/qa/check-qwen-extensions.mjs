/**
 * Расширения Qwen Code в разделе «Плагины» (MAP 25) — настоящим qwen через
 * настоящую панель.
 *
 * Панель ничего не пишет в каталог расширений сама: она зовёт `qwen extensions
 * install --consent | enable|disable --scope user | uninstall` и читает
 * манифесты. Вопрос — делает ли это то, что обещает экран. Сценарии:
 *   1. раздел виден как расширения (`qwen-extensions`, действия разрешены),
 *      каталог пуст;
 *   2. отказы до CLI: источник `--help` — 400, чужое имя — 404, файловый
 *      маршрут — 409; каталог расширений не тронут;
 *   3. установка локальной папки — 200; манифест в `<QWEN_HOME>/extensions/`,
 *      сводка панели: включено, источник, команды, контекст;
 *   4. свидетель CLI: собственный `qwen extensions list` говорит ✓, а `qwen -p`
 *      приносит модели файл контекста расширения — расширение действует;
 *   5. выключение панелью — `list` говорит ✗, контекста у модели нет, сводка
 *      говорит «выключено»; включение — контекст вернулся (без этой пары
 *      проверка «выключено» не умела бы краснеть);
 *   6. повторная установка — 422 со словами CLI (путь отказа доходит);
 *   7. удаление — каталога нет, `list` о нём молчит.
 *
 * Подменена только модель (сетевая граница); панель и CLI настоящие. CLI — из
 * `STEER_CLI_DIR`, иначе из PATH; нет — «не проверено», код 2. Дом CLI и
 * панели — временные каталоги, настоящий `~/.qwen` не трогается.
 *
 * Запуск: node tools/qa/check-qwen-extensions.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const NAME = 'qa-ext';
const CONTEXT_MARK = 'QWEN_EXTENSION_CONTEXT_6631';

function findCli() {
  const names = IS_WIN ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка OpenAI chat: всегда «DONE», каждый запрос запоминается целиком. */
async function startModel() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) return void res.writeHead(404).end();
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
      const send = (choice, usage) =>
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [choice], ...(usage ? { usage } : {}) })}\n\n`,
        );
      send({ index: 0, delta: { role: 'assistant', content: 'DONE' } });
      send(
        { index: 0, delta: {}, finish_reason: 'stop' },
        { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${server.address().port}`, bodies, close: () => server.close() };
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: qwen нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const cli = join(cliDir, IS_WIN ? 'qwen.cmd' : 'qwen');

const model = await startModel();
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qwen-ext-')));
const qwenHome = join(root, 'qwen-home');
const extensionsDir = join(qwenHome, 'extensions');
mkdirSync(qwenHome, { recursive: true });
Object.assign(process.env, {
  QWEN_HOME: qwenHome,
  OPENAI_BASE_URL: `${model.base}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
  QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
});

// Источник: локальная папка с манифестом, командой и файлом контекста.
const source = join(root, 'src-ext');
mkdirSync(join(source, 'commands'), { recursive: true });
writeFileSync(
  join(source, 'qwen-extension.json'),
  JSON.stringify({
    name: NAME,
    version: '1.2.3',
    description: { en: 'QA extension', zh: '测试' },
    contextFileName: 'QA.md',
  }),
);
writeFileSync(join(source, 'QA.md'), `${CONTEXT_MARK}: follow the QA extension.\n`);
writeFileSync(join(source, 'commands', 'hi.md'), 'Say hi {{args}}\n');

/** Запуск CLI мимо панели — тот же дом, что у панели (уровень «пользователь»). */
function runCli(args, cwd, home) {
  return new Promise((done) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const child = IS_WIN
      ? spawn(`"${cli}" ${args.map((arg) => `"${arg}"`).join(' ')}`, { cwd, shell: true, env })
      : spawn(cli, args, { cwd, env });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

let stand;
try {
  stand = await startStand({
    label: 'qwen-ext',
    settings: { provider: 'qwen' },
    web: false,
    extraPath: [cliDir],
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);
  const work = join(stand.home, 'work');
  mkdirSync(work, { recursive: true });
  const mark = async () => (await runCli(['extensions', 'list'], stand.home, stand.home)).trim();
  /** Дошёл ли контекст расширения до модели в новом разговоре `qwen -p`. */
  const contextReached = async () => {
    const from = model.bodies.length;
    await runCli(['-p', 'hello'], work, stand.home);
    const bodies = model.bodies.slice(from);
    if (bodies.length === 0) throw new NotChecked('qwen -p не дошёл до заглушки модели');
    return bodies.join('\n').includes(CONTEXT_MARK);
  };
  const info = async () => (await stand.api('/provider-plugins')).body;

  console.log('1. Раздел расширений Qwen');
  const providers = (await stand.api('/providers')).body;
  const qwen = providers?.providers?.find((item) => item.id === 'qwen');
  check(
    'возможность plugins ready, модель раздела files',
    qwen?.capabilities?.plugins === 'ready' && qwen?.pluginsModel === 'files',
    JSON.stringify({ cap: qwen?.capabilities?.plugins, model: qwen?.pluginsModel }),
  );
  const empty = await info();
  check(
    'формат qwen-extensions, действия есть, каталог <QWEN_HOME>/extensions пуст',
    empty?.format === 'qwen-extensions' &&
      empty?.installedActions === true &&
      empty?.pluginsDir === extensionsDir &&
      empty?.installed?.length === 0,
    JSON.stringify(empty),
  );

  console.log('\n2. Отказы до CLI');
  const flag = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source: '--help' },
  });
  check('источник «--help» — 400', flag.status === 400, flag.text);
  const ghost = await stand.api('/provider-plugins/installed/ghost', { method: 'DELETE' });
  check('чужое имя — 404', ghost.status === 404, ghost.text);
  const file = await stand.api('/provider-plugins/file', {
    method: 'PUT',
    body: { path: 'evil.js', content: 'x' },
  });
  check('файловый маршрут — 409', file.status === 409, file.text);
  check(
    'каталог расширений не появился',
    !existsSync(extensionsDir) ||
      readdirSync(extensionsDir).every((entry) => entry.endsWith('.json')),
  );

  console.log('\n3. Установка панелью');
  const installed = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source },
  });
  check('POST installed — 200', installed.status === 200, installed.text);
  check(
    'манифест лёг в каталог расширений',
    existsSync(join(extensionsDir, NAME, 'qwen-extension.json')),
  );
  const after = (await info())?.installed?.find((item) => item.id === NAME);
  check(
    'сводка: включено, версия, описание en, источник local, команды, контекст QA.md',
    after?.enabled === true &&
      after?.version === '1.2.3' &&
      after?.description === 'QA extension' &&
      after?.source === source &&
      after?.sourceType === 'local' &&
      after?.hasCommands === true &&
      after?.contextFiles?.join() === 'QA.md',
    JSON.stringify(after),
  );

  console.log('\n4. Свидетель CLI: расширение действует');
  const listOn = await mark();
  check(`qwen extensions list: ✓ ${NAME}`, listOn.includes(`✓ ${NAME}`), listOn.slice(0, 300));
  check('контекст расширения дошёл до модели', await contextReached());

  console.log('\n5. Выключение и включение панелью');
  const off = await stand.api(`/provider-plugins/installed/${NAME}/disable`, { method: 'POST' });
  check('disable — 200', off.status === 200, off.text);
  const listOff = await mark();
  check(`qwen extensions list: ✗ ${NAME}`, listOff.includes(`✗ ${NAME}`), listOff.slice(0, 300));
  check('сводка панели: выключено', (await info())?.installed?.[0]?.enabled === false);
  check('контекста выключенного расширения у модели нет', !(await contextReached()));
  const on = await stand.api(`/provider-plugins/installed/${NAME}/enable`, { method: 'POST' });
  check('enable — 200', on.status === 200, on.text);
  check('контекст вернулся', await contextReached());

  console.log('\n6. Повторная установка — отказ словами CLI');
  const again = await stand.api('/provider-plugins/installed', {
    method: 'POST',
    body: { source },
  });
  check(
    '422 cli_failed, причина — текст CLI',
    again.status === 422 &&
      again.body?.messageCode === 'qwen-extension-cli-failed' &&
      typeof again.body?.params?.reason === 'string' &&
      again.body.params.reason.length > 0,
    again.text,
  );

  console.log('\n7. Удаление панелью');
  const removed = await stand.api(`/provider-plugins/installed/${NAME}`, { method: 'DELETE' });
  check('DELETE — 200', removed.status === 200, removed.text);
  check('каталога расширения нет', !existsSync(join(extensionsDir, NAME)));
  const listEnd = await mark();
  check('qwen extensions list о нём молчит', !listEnd.includes(NAME), listEnd.slice(0, 300));
  check('сводка пуста', (await info())?.installed?.length === 0);
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error instanceof Error ? error.stack : String(error));
  }
} finally {
  await stand?.stop();
  // Корень прогона (проект, домашний каталог CLI) — иначе он копился в temp.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Держит ещё не вышедший CLI — на вердикт проверки это не влияет.
  }
  model.close();
}
if (process.exitCode !== 2) finish();
