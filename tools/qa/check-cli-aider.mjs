/**
 * Aider через панель — настоящим CLI. Кейсы cli-aider-001 (чат), cli-aider-002 (ключ).
 *
 * Голый `aider --message` без человека отвечает «да» на КАЖДЫЙ свой вопрос (stdin
 * закрыт, ответ по умолчанию — «да»): живая проба 06.10.2026 (aider-chat 0.86.2)
 * показала правку файла при выключенных правках, коммит в репозитории человека,
 * дописанный `.gitignore`, `git init` в каталоге без репозитория, запуск команды
 * оболочки из ответа модели и служебный вывод в ответе. Здесь — путь человека
 * через API панели: разговор в каталоге-репозитории, переключатель правок, ответ.
 *
 * Подменена только модель (сетевая граница): своя OpenAI-совместимая заглушка
 * (`OPENAI_API_BASE`, задокументированная переменная Aider), ответ — по сценарию.
 * Формат правок `diff` (`AIDER_EDIT_FORMAT`) — тот, что Aider берёт для настоящих
 * моделей; в нём же Aider видит в ответе команды оболочки.
 *
 * Сценарии (каждый — свой разговор):
 *  A. обычный ответ по-русски — в переписке ровно текст заглушки, без заставки;
 *     заглушка видела файл репозитория в карте (git включён для репозитория);
 *  B. правки выключены, модель правит файл — файл цел;
 *  C. правки выключены, модель предлагает команду оболочки — команда не запущена;
 *  D. правки включены — файл изменён, НОВОГО КОММИТА НЕТ;
 *  E. правки включены, команда оболочки — не запущена;
 *  F. каталог без репозитория, правки включены — правка есть, `.git` не появился.
 * Плюс: история коммитов та же, `.gitignore` и файлы истории Aider не созданы,
 * настоящие каталоги CLI человека (`~/.aider*` и прочие) не тронуты.
 *
 * Ключ (cli-aider-002): второй стенд БЕЗ aider в PATH, в окружении метки
 * OPENAI_API_KEY и ANTHROPIC_API_KEY, `fetch` панели перехвачен (`NODE_OPTIONS
 * --import`, запрос наружу записывается и не уходит). Метка OpenAI обязана дойти
 * до api.openai.com и только туда, метка Anthropic — никуда.
 *
 * CLI: `AIDER_CLI_DIR` (каталоги через разделитель PATH), иначе PATH. Нет — «не
 * проверено» (код 2) по чату; ключ проверяется всё равно.
 *
 * Запуск: `node tools/qa/check-cli-aider.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffRealProviderDirs,
  LIVE_SESSION_CHURN,
  reporter,
  snapshotRealProviderDirs,
  startStand,
  wait,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';

function findAiderDir() {
  const names = IS_WIN ? ['aider.exe', 'aider.cmd', 'aider'] : ['aider'];
  const dirs = [
    ...(process.env.AIDER_CLI_DIR ? process.env.AIDER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

const { check, finish, failed } = reporter();
let notChecked = '';

// --- заглушка модели: ответ по сценарию, запись запросов с заголовками -------
const stub = { reply: '', requests: [] };
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      // не JSON — ответ по сценарию всё равно
    }
    stub.requests.push({ path: req.url, auth: req.headers.authorization, raw });
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
      return;
    }
    const text = stub.reply;
    const head = { id: 'c1', created: 1, model: body.model ?? 'stub-model' };
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Кусками — как настоящая модель: разбор stdout обязан склеить ответ сам.
      for (const part of [text.slice(0, 7), text.slice(7, 30), text.slice(30)]) {
        const chunk = { ...head, object: 'chat.completion.chunk' };
        chunk.choices = [{ index: 0, delta: { content: part } }];
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      const last = { ...head, object: 'chat.completion.chunk', usage };
      last.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
      res.write(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const message = { role: 'assistant', content: text };
    res.end(
      JSON.stringify({
        ...head,
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage,
      }),
    );
  });
});
await new Promise((done) => model.listen(0, '127.0.0.1', done));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

const PLAIN = 'Привет из заглушки: «ёлка» — 42.\n\nВторая строка ответа.';
const EDIT = [
  'Меняю файл.',
  '',
  'note.txt',
  '```',
  '<<<<<<< SEARCH',
  'ORIGINAL',
  '=======',
  'CHANGED BY STUB',
  '>>>>>>> REPLACE',
  '```',
  '',
].join('\n');
const SHELL = ['Запусти это:', '', '```bash', 'echo shell-ran > ran.txt', '```', ''].join('\n');
const CHROME = ['Aider v', 'Model:', 'Git repo:', 'Repo-map:', 'Tokens:', '(Y)es', 'Update git'];

// --- каталоги разговоров -----------------------------------------------------
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-cli-aider-')));
const repo = join(root, 'repo');
const plain = join(root, 'plain');
mkdirSync(repo, { recursive: true });
mkdirSync(plain, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const resetNote = (dir) => writeFileSync(join(dir, 'note.txt'), 'ORIGINAL\n');
resetNote(repo);
resetNote(plain);
git('init', '-q');
// Имя и почта — в конфиге репозитория: без них Aider сам вписал бы «Your Name».
git('config', 'user.name', 'qa');
git('config', 'user.email', 'qa@example.com');
git('add', '.');
git('commit', '-qm', 'init');
const headBefore = git('rev-parse', 'HEAD');
const note = (dir) => readFileSync(join(dir, 'note.txt'), 'utf8').replace(/\r\n/g, '\n');

const realBefore = snapshotRealProviderDirs();

/** Один вопрос в своём разговоре; итог — последняя реплика. */
async function ask(stand, { workdir, allowEdits, text, reply }) {
  stub.reply = reply;
  const created = await stand.api('/provider-chat/chats', { method: 'POST', body: { workdir } });
  if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
  const id = created.body.id;
  const rights = await stand.api(`/provider-chat/chats/${id}`, {
    method: 'PATCH',
    body: { allowEdits },
  });
  if (rights.status !== 200) throw new Error(`переключатель правок: ${rights.text}`);
  const before = stub.requests.length;
  const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
    method: 'POST',
    body: { text },
  });
  if (sent.status !== 200) throw new Error(`вопрос не принят: ${sent.text}`);
  for (let i = 0; i < 720; i += 1) {
    await wait(250);
    if ((await stand.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false) break;
  }
  const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
  return { last: chat?.messages?.at(-1), requests: stub.requests.slice(before) };
}

const show = (value) => JSON.stringify(value).slice(0, 600);
const noChrome = (content) => CHROME.filter((mark) => String(content).includes(mark));

// --- стенд 1: настоящий aider ------------------------------------------------
const aiderDir = findAiderDir();
if (!aiderDir) {
  notChecked = 'aider нет ни в AIDER_CLI_DIR, ни в установке прохода, ни в PATH';
  console.log(`Не проверено (чат): ${notChecked}`);
} else {
  console.log(`aider: ${aiderDir}`);
  const stubKey = `qa-aider-stub-${Math.random().toString(36).slice(2, 8)}`;
  let stand;
  try {
    stand = await startStand({
      label: 'cli-aider',
      web: false,
      noClaude: true,
      settings: { provider: 'aider' },
      extraPath: [aiderDir],
      env: {
        OPENAI_API_KEY: stubKey,
        OPENAI_API_BASE: modelUrl,
        AIDER_MODEL: 'openai/stub-model',
        AIDER_EDIT_FORMAT: 'diff',
      },
    });
    console.log(`Одноразовая панель ${stand.apiUrl}\n`);
    const runner = (await stand.api('/provider-runner')).body;
    check(
      `раннер: CLI найден, режим cli (${runner?.mode}/${runner?.reason})`,
      runner?.cliFound === true && runner?.mode === 'cli',
      show(runner),
    );

    console.log('\nA. обычный ответ, правки выключены');
    const a = await ask(stand, {
      workdir: repo,
      allowEdits: false,
      text: 'Скажи привет.',
      reply: PLAIN,
    });
    check('A: ответ — ровно текст заглушки', a.last?.content === PLAIN, show(a.last));
    check('A: ответ одиночным запуском (stream)', a.last?.transport === 'stream', show(a.last));
    check(
      'A: служебного вывода в ответе нет',
      noChrome(a.last?.content).length === 0,
      show(a.last),
    );
    check(
      'A: модель получила запрос ключом заглушки',
      a.requests.length > 0 && a.requests.every((r) => r.auth === `Bearer ${stubKey}`),
      show(a.requests.map((r) => [r.path, r.auth])),
    );
    check(
      'A: репозиторий виден модели (git включён: note.txt в карте)',
      a.requests.some((r) => r.raw.includes('note.txt')),
      `${a.requests.length} запрос(ов)`,
    );

    console.log('\nB. правки выключены, модель правит файл');
    const b = await ask(stand, {
      workdir: repo,
      allowEdits: false,
      text: 'Поправь note.txt.',
      reply: EDIT,
    });
    check('B: файл цел', note(repo) === 'ORIGINAL\n', note(repo));
    check(
      'B: в ответе правка и честное «не применено (--dry-run)»',
      String(b.last?.content).includes('CHANGED BY STUB') &&
        String(b.last?.content).includes('(--dry-run)'),
      show(b.last),
    );
    check(
      'B: служебного вывода в ответе нет',
      noChrome(b.last?.content).length === 0,
      show(b.last),
    );

    console.log('\nC. правки выключены, модель предлагает команду оболочки');
    await ask(stand, { workdir: repo, allowEdits: false, text: 'Выполни команду.', reply: SHELL });
    check('C: команда не запущена (ran.txt нет)', !existsSync(join(repo, 'ran.txt')));

    console.log('\nD. правки включены');
    const d = await ask(stand, {
      workdir: repo,
      allowEdits: true,
      text: 'Поправь note.txt.',
      reply: EDIT,
    });
    check('D: файл изменён', note(repo) === 'CHANGED BY STUB\n', note(repo));
    check(
      'D: служебного вывода в ответе нет',
      noChrome(d.last?.content).length === 0,
      show(d.last),
    );

    console.log('\nE. правки включены, команда оболочки');
    await ask(stand, { workdir: repo, allowEdits: true, text: 'Выполни команду.', reply: SHELL });
    check('E: команда не запущена (ran.txt нет)', !existsSync(join(repo, 'ran.txt')));

    console.log('\nрепозиторий после A–E');
    check('коммитов не прибавилось (HEAD прежний)', git('rev-parse', 'HEAD') === headBefore);
    check('в истории ровно один коммит', git('rev-list', '--count', 'HEAD') === '1');
    const status = git('status', '--porcelain', '--untracked-files=all');
    check('.gitignore не создан и не тронут', !existsSync(join(repo, '.gitignore')), status);
    check(
      'файлов истории Aider в проекте нет',
      !existsSync(join(repo, '.aider.chat.history.md')) &&
        !existsSync(join(repo, '.aider.input.history')),
      status,
    );
    check(
      'изменён только note.txt (кэш карты Aider — неотслеживаемый)',
      status
        .split('\n')
        .filter(Boolean)
        // `git()` срезает пробел первой строки — сравниваем без него.
        .every((line) => line.trim() === 'M note.txt' || line.includes('.aider.tags.cache')),
      status,
    );

    console.log('\nF. каталог без репозитория, правки включены');
    const f = await ask(stand, {
      workdir: plain,
      allowEdits: true,
      text: 'Поправь note.txt.',
      reply: EDIT,
    });
    check('F: правка применена', note(plain) === 'CHANGED BY STUB\n', note(plain));
    check('F: git init не сделан (.git нет)', !existsSync(join(plain, '.git')), show(f.last));
  } catch (error) {
    check('сценарий чата дошёл до конца', false, error?.stack ?? String(error));
    if (stand) console.log(stand.log().slice(-2000));
  } finally {
    if (stand) await stand.stop();
  }
}

// --- стенд 2: без aider, ключи-метки, fetch панели перехвачен ----------------
console.log('\nключ: aider нет в PATH, в окружении метки OpenAI и Anthropic');
const SENT_OPENAI = 'qa-aider-openai-key-5Tz1';
const SENT_ANTHROPIC = 'qa-aider-anthropic-key-8Wq3';
const offBoxLog = join(root, 'off-box.jsonl');
const preload = join(root, 'fetch-trap.mjs');
writeFileSync(
  preload,
  `import { appendFileSync } from 'node:fs';
const real = globalThis.fetch;
const headersOf = (h) => (!h ? {} : typeof h.entries === 'function' ? Object.fromEntries(h.entries()) : { ...h });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return real(input, init);
  appendFileSync(${JSON.stringify(offBoxLog)}, JSON.stringify({ url, headers: headersOf(init.headers), body: typeof init.body === 'string' ? init.body : '' }) + '\\n');
  return new Response('{"error":"qa trap: off-box request"}', { status: 599, headers: { 'content-type': 'application/json' } });
};
`,
  'utf8',
);
const offBox = () =>
  existsSync(offBoxLog)
    ? readFileSync(offBoxLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const carriers = (sentinel) =>
  offBox()
    .filter((hit) => JSON.stringify(hit).includes(sentinel))
    .map((hit) => hit.url.replace(/\?.*$/, ''));

let keyStand;
try {
  keyStand = await startStand({
    label: 'cli-aider-key',
    web: false,
    noClaude: true,
    settings: { provider: 'aider' },
    env: {
      OPENAI_API_KEY: SENT_OPENAI,
      ANTHROPIC_API_KEY: SENT_ANTHROPIC,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    },
  });
  const runner = (await keyStand.api('/provider-runner')).body;
  check(
    `ключ: aider в PATH стенда нет, режим api (${runner?.mode}/${runner?.reason})`,
    runner?.cliFound === false && runner?.mode === 'api',
    show(runner),
  );
  stub.requests.length = 0;
  const k = await ask(keyStand, { allowEdits: false, text: 'вопрос', reply: 'не должно дойти' });
  const openai = carriers(SENT_OPENAI);
  check(
    `ключ: метка OpenAI дошла до api.openai.com (${openai.length})`,
    openai.length > 0 && openai.every((url) => url.startsWith('https://api.openai.com/')),
    `${openai.join('; ')} | ${show(k.last)}`,
  );
  const anthropic = carriers(SENT_ANTHROPIC);
  check('ключ: метка Anthropic не ушла никуда (0)', anthropic.length === 0, anthropic.join('; '));
  check('ключ: заглушка модели запросов не получила', stub.requests.length === 0);
} catch (error) {
  check('сценарий ключа дошёл до конца', false, error?.stack ?? String(error));
  if (keyStand) console.log(keyStand.log().slice(-2000));
} finally {
  if (keyStand) await keyStand.stop();
}

// `~/.claude/agentdeck/state.json` пишет рабочая панель человека (:5178), пока
// идёт проверка: её стенды здесь — `noClaude`, со своим временным домом, и в
// настоящий каталог Claude не пишут. Исключён только этот файл и его каталог.
const drift = diffRealProviderDirs(realBefore, snapshotRealProviderDirs(), {
  ignore: [...LIVE_SESSION_CHURN, /\/\.claude\/agentdeck(\/state\.json)?$/],
});
check(
  'настоящие каталоги CLI человека не тронуты',
  drift.length === 0,
  drift
    .slice(0, 10)
    .map((item) => `${item.path}: ${item.before} → ${item.after}`)
    .join('; '),
);

model.closeAllConnections?.();
model.close();
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (error) {
  console.log(`  ! временный каталог не удалён: ${root} (${error.code ?? error.message})`);
}
// Провалов нет, но чат без CLI не проверен — это «не проверено», а не «всё сходится».
if (notChecked && failed() === 0) {
  console.log(`\nПровалов нет; не проверено: ${notChecked}`);
  process.exit(2);
}
finish();
