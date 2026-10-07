/**
 * Раздел «Правила» у Qwen Code (MAP 24) — настоящим qwen через настоящую панель.
 *
 * Панель пишет правила в `<QWEN_HOME>/rules/*.md` своим API, и вопрос один: в той
 * ли форме, которую CLI действительно читает. Сценарии:
 *   1. раздел виден как каталог правил Qwen (`rulesModel: files`), каталога ещё
 *      нет; `alwaysApply` формату чужой — 400, файл не появился;
 *   2. панель создаёт постоянное правило (без шаблонов) и условное
 *      (`paths: src/**\/*.tsx`); на диске — `.md`, у условного список `paths`;
 *   3. вопрос в разговоре Qwen: постоянное правило в первом же запросе к модели,
 *      условного там нет;
 *   4. модель просит прочитать `src/App.tsx`. В чате панели (`qwen serve`)
 *      условное правило НЕ приходит: qwen 0.25 подключает такие правила только
 *      в планировщике инструментов терминального режима, а serve исполняет
 *      инструменты через ACP мимо него. Это ограничение CLI, и проверка держит
 *      его как сторожа: покраснело — qwen починил, справку пора править;
 *   5. тот же файл правила — настоящему `qwen -p` в терминальном режиме:
 *      после чтения `src/App.tsx` условное правило приходит модели, чтение
 *      `README.md` (вне шаблона) его не подключает — формат панели CLI читает;
 *   6. панель удаляет постоянное правило — в новом разговоре его у модели нет
 *      (контроль: без этого шага проверка не умела бы краснеть).
 *
 * Свидетель — тело запроса, дошедшего до заглушки модели. Подменена только
 * модель (сетевая граница); панель, служба чата и CLI — настоящие. CLI — из
 * `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH; нет его —
 * «не проверено», код 2. Дом CLI и панели — временные каталоги.
 *
 * Запуск: node tools/qa/check-qwen-rules.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const ALWAYS_MARK = 'QWEN_ALWAYS_RULE_5521';
const COND_MARK = 'QWEN_TSX_RULE_7713';
// Тексты файлов: их появление в запросе к модели доказывает, что чтение удалось
// (иначе отказ «File not found» сделал бы проверки «правила нет» пустыми).
const APP_TEXT = 'export const App = () => null;';
const README_TEXT = '# readme marker 4410';

function findCli() {
  const names = IS_WIN ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * Заглушка OpenAI chat. Последнее сообщение пользователя с `READ <путь>` —
 * ответ вызовом `read_file` по этому пути; иначе (в том числе после результата
 * инструмента) — «DONE». Каждый запрос запоминается целиком.
 */
async function startModel() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) return void res.writeHead(404).end();
      bodies.push(body);
      const messages = JSON.parse(body).messages ?? [];
      const last = messages.at(-1);
      // content бывает строкой (serve) и списком частей (`qwen -p`): берём текст,
      // а не JSON — иначе в путь уезжают кавычки и скобки обёртки.
      const text =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((part) => part?.text ?? '').join('\n');
      const asked = last?.role === 'user' ? /READ (\S+)/.exec(text)?.[1] : undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
      const send = (choice, usage) =>
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [choice], ...(usage ? { usage } : {}) })}\n\n`,
        );
      if (asked) {
        send({
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${bodies.length}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ file_path: asked }) },
              },
            ],
          },
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        send({ index: 0, delta: { role: 'assistant', content: 'DONE' } });
        send(
          { index: 0, delta: {}, finish_reason: 'stop' },
          { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        );
      }
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

const model = await startModel();
// Длинный путь: у TEMP бывает короткое имя 8.3 (RUSYAN~1), а qwen сопоставляет
// шаблоны с разрешённым путём — от короткого корня файл оказался бы «вне проекта».
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-qwen-rules-')));
const qwenHome = join(root, 'qwen-home');
const rulesDir = join(qwenHome, 'rules');
mkdirSync(qwenHome, { recursive: true });
Object.assign(process.env, {
  QWEN_HOME: qwenHome,
  OPENAI_BASE_URL: `${model.base}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
  QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
});

let stand;
try {
  stand = await startStand({
    label: 'qwen-rules',
    settings: { provider: 'qwen' },
    web: false,
    extraPath: [cliDir],
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);

  console.log('1. Раздел правил Qwen');
  const providers = (await stand.api('/providers')).body;
  const qwen = providers?.providers?.find((item) => item.id === 'qwen');
  check(
    'модель раздела files, возможность ready',
    qwen?.rulesModel === 'files' && qwen?.capabilities?.rules === 'ready',
    JSON.stringify({ model: qwen?.rulesModel, cap: qwen?.capabilities?.rules }),
  );
  const empty = await stand.api('/provider-rules');
  check(
    'каталог — <QWEN_HOME>/rules, его ещё нет, формат qwen-md',
    empty.status === 200 &&
      empty.body?.rulesDir === rulesDir &&
      empty.body?.dirExists === false &&
      empty.body?.format === 'qwen-md',
    empty.text,
  );
  const refused = await stand.api('/provider-rules/rule', {
    method: 'PUT',
    body: { path: 'bad.md', alwaysApply: true, body: 'x' },
  });
  check(
    'alwaysApply — 400, файл не появился',
    refused.status === 400 && !existsSync(join(rulesDir, 'bad.md')),
    refused.text,
  );

  console.log('\n2. Панель создаёт два правила');
  const always = await stand.api('/provider-rules/rule', {
    method: 'PUT',
    body: { path: 'always.md', body: `${ALWAYS_MARK}: answer in one word.\n` },
  });
  const conditional = await stand.api('/provider-rules/rule', {
    method: 'PUT',
    body: {
      path: 'frontend/react.md',
      description: 'React components',
      globs: 'src/**/*.tsx',
      body: `${COND_MARK}: components are functions.\n`,
    },
  });
  check('оба сохранены', always.status === 200 && conditional.status === 200, conditional.text);
  const alwaysText = readFileSync(join(rulesDir, 'always.md'), 'utf8');
  const condText = readFileSync(join(rulesDir, 'frontend', 'react.md'), 'utf8');
  check(
    'постоянное — без шапки, одно тело',
    alwaysText === `${ALWAYS_MARK}: answer in one word.\n`,
    alwaysText,
  );
  check(
    'условное — paths списком и description',
    condText.startsWith('---\ndescription: React components\npaths:\n  - src/**/*.tsx\n---\n'),
    condText,
  );
  const overview = (await stand.api('/overview')).body;
  check(
    'счётчик раздела в обзоре и боковой панели — 2 правила Qwen',
    overview?.rules?.total === 2,
    JSON.stringify(overview?.rules),
  );

  const project = (name) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'App.tsx'), `${APP_TEXT}\n`);
    writeFileSync(join(dir, 'README.md'), `${README_TEXT}\n`);
    return dir;
  };
  const ask = async (dir, text) => {
    const chat = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { workdir: dir },
    });
    if (chat.status !== 200) throw new Error(`разговор не создан: ${chat.text}`);
    const id = chat.body.id;
    const from = model.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text },
    });
    check('вопрос принят', sent.status === 200, sent.text);
    for (let i = 0; i < 480; i += 1) {
      const status = (await stand.api(`/provider-chat/chats/${id}/status`)).body;
      if (status?.isRunning === false && model.bodies.length > from) break;
      await wait(250);
    }
    await wait(500);
    return model.bodies.slice(from);
  };

  /** Терминальный режим: `qwen -p` в каталоге проекта, тот же дом и модель. */
  const askTerminal = async (dir, text) => {
    const from = model.bodies.length;
    const cli = join(cliDir, IS_WIN ? 'qwen.cmd' : 'qwen');
    await new Promise((done) => {
      // Windows: .cmd запускается только через оболочку — одной строкой, в
      // кавычках как есть (JSON.stringify удвоил бы обратные слеши пути, и шаблон
      // правила с ним уже не сошёлся бы).
      const child = IS_WIN
        ? spawn(`"${cli}" -p "${text}" --yolo`, { cwd: dir, shell: true, env: process.env })
        : spawn(cli, ['-p', text, '--yolo'], { cwd: dir, env: process.env });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
    return model.bodies.slice(from);
  };

  console.log('\n3–4. Чат панели (qwen serve): постоянное сразу, условное — ограничение CLI');
  const dir = project('work');
  const turns = await ask(dir, `READ ${join(dir, 'src', 'App.tsx')}`);
  const sawFile = (bodies, text) => bodies.slice(1).some((body) => body.includes(text));
  check('файл прочитан, его текст дошёл до модели', sawFile(turns, APP_TEXT), String(turns.length));
  check('постоянное правило в первом запросе', turns[0]?.includes(ALWAYS_MARK) === true);
  check('условного в первом запросе нет', turns[0]?.includes(COND_MARK) === false);
  check(
    'serve: условное после чтения не пришло (ограничение qwen 0.25; красное — qwen починил, править справку)',
    sawFile(turns, APP_TEXT) && !sawFile(turns, COND_MARK),
  );

  console.log('\n5. Терминальный qwen -p читает тот же файл правила');
  const term = project('term');
  const read = await askTerminal(term, `READ ${join(term, 'src', 'App.tsx')}`);
  check('файл прочитан, его текст дошёл до модели', sawFile(read, APP_TEXT), String(read.length));
  check('условного в первом запросе нет', read[0]?.includes(COND_MARK) === false);
  check('после чтения src/App.tsx условное правило пришло модели', sawFile(read, COND_MARK));
  const other = project('other');
  const readme = await askTerminal(other, `READ ${join(other, 'README.md')}`);
  check('README.md прочитан, его текст дошёл до модели', sawFile(readme, README_TEXT));
  check(
    'чтение README.md (вне шаблона) условное не подключает',
    !readme.join('\n').includes(COND_MARK),
  );

  console.log('\n6. Контроль: правило удалено панелью');
  const removed = await stand.api(`/provider-rules/rule?path=${encodeURIComponent('always.md')}`, {
    method: 'DELETE',
  });
  check(
    'удалено',
    removed.status === 200 && !existsSync(join(rulesDir, 'always.md')),
    removed.text,
  );
  const after = await ask(project('after'), 'Привет');
  check('запрос дошёл до модели', after.length > 0);
  check('удалённого правила у модели нет', !after.join('\n').includes(ALWAYS_MARK));
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
