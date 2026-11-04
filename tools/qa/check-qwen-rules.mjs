/**
 * Раздел «Правила» у Qwen Code (MAP 24) — настоящим qwen через настоящую панель.
 *
 * Панель пишет правила в `<QWEN_HOME>/rules/*.md` своим API, и вопрос один: в той
 * ли форме, которую CLI действительно читает. Сценарии:
 *   1. раздел виден как каталог правил Qwen (`rulesModel: files`), каталога ещё
 *      нет; `alwaysApply` формату чужой — 400, файл не появился;
 *   2. панель создаёт постоянное правило (без шаблонов) и условное
 *      (`paths: src/**\/*.tsx`); на диске — `.md`, у условного список `paths`;
 *   3. настоящий `qwen -p` в каталоге проекта с тем же домом: постоянное правило
 *      в первом же запросе к модели, условного там нет;
 *   4–5. модель просит прочитать `src/App.tsx` — после чтения условное правило
 *      приходит модели; чтение `README.md` (вне шаблона) его не подключает —
 *      формат панели CLI читает;
 *   6. панель удаляет постоянное правило — в новом запуске его у модели нет
 *      (контроль: без этого шага проверка не умела бы краснеть).
 *
 * Разговор через чат панели (`qwen serve` её исполнителем) снят на этапе 10 (F2c): чат Qwen
 * идёт задачей ядра. Перенос правил человека в сеанс ядра — дело ядра и здесь не проверяется.
 *
 * Свидетель — тело запроса, дошедшего до заглушки модели. Подменена только
 * модель (сетевая граница); панель и CLI — настоящие. CLI — из
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
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

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
  const stub = await startStubModel({
    script: ({ request }) => {
      const last = (request.body.messages ?? []).at(-1);
      // content бывает строкой (serve) и списком частей (`qwen -p`): берём текст,
      // а не JSON — иначе в путь уезжают кавычки и скобки обёртки.
      const text =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((part) => part?.text ?? '').join('\n');
      const asked = last?.role === 'user' ? /READ (\S+)/.exec(text)?.[1] : undefined;
      return asked
        ? { tool: { name: 'read_file', args: { file_path: asked } } }
        : { text: 'DONE', usage: { input: 5, output: 1 } };
    },
  });
  return { base: stub.baseUrl, bodies: stub.bodies, close: () => stub.close() };
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
  /**
   * Терминальный режим: `qwen -p` в каталоге проекта, тот же дом и модель. Чат панели (`qwen
   * serve` её исполнителем) снят на этапе 10 (F2c): вопрос один — читает ли CLI файл правила в
   * форме панели, и отвечает на него сам CLI из того же дома.
   */
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

  console.log('\n3–4. qwen -p: постоянное правило сразу, условное — после чтения по шаблону');
  const sawFile = (bodies, text) => bodies.slice(1).some((body) => body.includes(text));
  const term = project('term');
  const read = await askTerminal(term, `READ ${join(term, 'src', 'App.tsx')}`);
  check('файл прочитан, его текст дошёл до модели', sawFile(read, APP_TEXT), String(read.length));
  check('постоянное правило в первом запросе', read[0]?.includes(ALWAYS_MARK) === true);
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
  const after = await askTerminal(project('after'), 'Привет');
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
