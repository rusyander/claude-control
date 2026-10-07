/**
 * Gemini CLI в чате панели: «Разрешить правки» доходит флагом, ответ — без
 * служебного вывода CLI. Кейсы cli-gemini-*.
 *
 * Настоящий экземпляр панели (`apps/server/src/index.ts`) на одноразовом доме и
 * НАСТОЯЩИЙ `gemini` (@google/gemini-cli) в конце его PATH: панель находит
 * `.cmd`-обёртку npm и запускает её node-скрипт сама, как у человека. Подменена
 * только модель — внешняя граница: `GOOGLE_GEMINI_BASE_URL` смотрит на заглушку
 * проверки, говорящую на `streamGenerateContent` Google (SSE). Ключ — метка.
 *
 * Дом CLI — временный: `~/.gemini/settings.json` с выбором входа по ключу
 * (`security.auth.selectedType`; одного `GOOGLE_GEMINI_BASE_URL` 0.62.0 мало —
 * без выбора он сам ставит способ `gateway` и в `-p` падает «Invalid auth method
 * selected»), с `general.defaultApprovalMode: auto_edit` — выключенный
 * переключатель обязан быть сильнее настройки — и `trustedFolders.json`, как
 * после «доверять папке» в интерактивном режиме: недоверенную папку `-p`
 * отвергает (код 55). Модель закреплена `<папка>/.gemini/.env`: CLI ищет `.env`
 * вверх от рабочей папки до корня диска, и чужой файл выше %TEMP% подменил бы
 * её.
 *
 * Свидетельства: файл в рабочей папке, тело запросов к заглушке (какие
 * инструменты CLI объявил модели), реплика разговора. Обёртка `fetch`
 * (`NODE_OPTIONS=--import`, её наследуют и панель, и CLI) пишет любой запрос
 * за пределы 127.0.0.1 и наружу его не пускает; снимок mtime настоящих
 * каталогов CLI человека до и после.
 *
 * `--keep-alive`: заглушка держит соединение, как обычный сервер. На win32
 * (gemini 0.62.0, node 24) ход с вызовом инструмента тогда кончается падением
 * CLI ПОСЛЕ полного ответа (libuv `async.c:76`, код 0xC0000409), и панель
 * выбрасывает готовый ответ как ошибку — кейс cli-gemini-002 это фиксирует.
 *
 * Запуск: `node tools/qa/check-cli-gemini.mjs [--keep-alive] [--server-dir <копия apps/server>]`;
 * `GEMINI_CLI_DIR` — каталог с `gemini`(.cmd), иначе первый каталог PATH, где он есть.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffRealProviderDirs,
  runOnStand,
  snapshotRealProviderDirs,
  wait,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const KEEP_ALIVE = process.argv.includes('--keep-alive');
const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

const GEMINI_FILE = IS_WIN ? 'gemini.cmd' : 'gemini';
const BIN_DIR = [
  process.env.GEMINI_CLI_DIR,
  ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
].find((dir) => dir && existsSync(join(dir, GEMINI_FILE)));
if (!BIN_DIR) {
  console.log('Не проверено: gemini нет ни в GEMINI_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const SENTINEL = 'qa-gemini-key-5Tz8';
const MODEL = 'gemini-2.5-flash';
const TARGET = 'gemini-probe.txt';
const WRITTEN = 'WRITTEN_BY_STUB';
const REPLY = 'GEMINI_STUB_REPLY';
const AFTER_TOOL = 'GEMINI_STUB_AFTER_TOOL';
/** Слова, по которым узнаётся служебный вывод CLI в ответе. */
const CHROME = /Warning:|YOLO mode|Ripgrep|Assertion failed|Loaded cached|Data collection/i;

// --- заглушка модели: Google generateContent / streamGenerateContent -------
const hits = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      // не JSON — сценарий по сырому тексту
    }
    const tools = (body.tools ?? [])
      .flatMap((group) => group.functionDeclarations ?? [])
      .map((fn) => fn.name);
    const answered = raw.includes('"functionResponse"');
    const wantsWrite = raw.includes('QA_WRITE');
    hits.push({ path: req.url, key: req.headers['x-goog-api-key'], tools, answered });
    // Сценарий: просьба записать и результата ещё нет — вызов `write_file`,
    // объявлен он CLI или нет (модель может попросить и необъявленный);
    // результат есть — итог после инструмента; иначе — простой ответ.
    const parts =
      wantsWrite && !answered
        ? [{ functionCall: { name: 'write_file', args: { file_path: TARGET, content: WRITTEN } } }]
        : [{ text: answered ? AFTER_TOOL : REPLY }];
    const payload = {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      modelVersion: MODEL,
    };
    const head = KEEP_ALIVE ? {} : { connection: 'close' };
    if (req.url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...head });
      res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`);
    } else if (req.url.includes(':countTokens')) {
      res.writeHead(200, { 'content-type': 'application/json', ...head });
      res.end(JSON.stringify({ totalTokens: 5 }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...head });
      res.end(JSON.stringify(payload));
    }
  });
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

// --- ловушка: любой fetch панели и CLI за пределы машины ---------------------
const work = mkdtempSync(join(tmpdir(), 'cc-gemini-trap-'));
process.once('exit', () => {
  stub.close();
  rmSync(work, { recursive: true, force: true });
});
const offBoxLog = join(work, 'off-box.jsonl');
const preload = join(work, 'fetch-trap.mjs');
writeFileSync(
  preload,
  `import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(offBoxLog)};
const real = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const { protocol, hostname: host } = new URL(url);
  // data:/file: — не сеть (CLI так грузит свой wasm); ловим только http(s) вне машины.
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!/^https?:$/.test(protocol) || local) {
    return real(input, init);
  }
  appendFileSync(LOG, JSON.stringify({ url, init: JSON.stringify(init ?? {}).slice(0, 4000) }) + '\\n');
  return new Response('{"error":"qa trap: off-box request"}', {
    status: 599,
    headers: { 'content-type': 'application/json' },
  });
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

const realBefore = snapshotRealProviderDirs();

let trusted = '';
let untrusted = '';

await runOnStand(
  {
    label: 'cli-gemini',
    web: false,
    noClaude: true,
    settings: { provider: 'gemini' },
    extraPath: [BIN_DIR],
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    env: {
      GOOGLE_GEMINI_BASE_URL: stubUrl,
      GEMINI_API_KEY: SENTINEL,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    },
    seed: ({ root, home }) => {
      const gemini = join(home, '.gemini');
      mkdirSync(gemini, { recursive: true });
      writeFileSync(
        join(gemini, 'settings.json'),
        `${JSON.stringify(
          {
            security: { auth: { selectedType: 'gemini-api-key' } },
            general: {
              defaultApprovalMode: 'auto_edit',
              disableAutoUpdate: true,
              disableUpdateNag: true,
            },
            privacy: { usageStatisticsEnabled: false },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      trusted = join(root, 'proj-trusted');
      untrusted = join(root, 'proj-untrusted');
      for (const dir of [trusted, untrusted]) {
        mkdirSync(join(dir, '.gemini'), { recursive: true });
        writeFileSync(join(dir, '.gemini', '.env'), `GEMINI_MODEL=${MODEL}\n`, 'utf8');
        // Недоверенная папка `.gemini/.env` не читает — простой `.env` держит
        // и её от поиска вверх по дереву.
        writeFileSync(join(dir, '.env'), `GEMINI_MODEL=${MODEL}\n`, 'utf8');
      }
      writeFileSync(
        join(gemini, 'trustedFolders.json'),
        `${JSON.stringify({ [trusted]: 'TRUST_FOLDER' }, null, 2)}\n`,
        'utf8',
      );
    },
  },
  async (stand, check) => {
    /** Один вопрос в новом разговоре; итог — последняя реплика и запросы к модели за ход. */
    const ask = async (workdir, allowEdits, text) => {
      const created = await stand.api('/provider-chat/chats', {
        method: 'POST',
        body: { workdir },
      });
      if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
      const id = created.body.id;
      const rights = await stand.api(`/provider-chat/chats/${id}`, {
        method: 'PATCH',
        body: { allowEdits },
      });
      if (rights.status !== 200) throw new Error(`права не заданы: ${rights.text}`);
      const from = hits.length;
      const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text },
      });
      if (sent.status !== 200) throw new Error(`вопрос не принят: ${sent.text}`);
      for (let i = 0; i < 600; i += 1) {
        await wait(200);
        if ((await stand.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false) break;
      }
      const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
      return { last: chat?.messages?.at(-1), requests: hits.slice(from) };
    };
    const show = (value) => JSON.stringify(value).slice(0, 400);
    const runner = (await stand.api('/provider-runner')).body;
    check(
      `раннер — CLI gemini из PATH (${runner?.mode}/${runner?.cliCommandFound ?? runner?.cliFound})`,
      runner?.cliFound === true,
      show(runner),
    );

    if (KEEP_ALIVE) {
      console.log(
        '\nсоединение с моделью держится (keep-alive), правки включены, просьба записать',
      );
      const turn = await ask(trusted, true, 'QA_WRITE запиши файл');
      check(
        'инструмент выполнен: файл записан',
        stand.read(join(trusted, TARGET)) === WRITTEN,
        String(stand.read(join(trusted, TARGET))),
      );
      check(
        `ответ доставлен целиком, а не ошибкой (${turn.last?.failed ? 'ошибка' : 'ответ'})`,
        turn.last?.role === 'assistant' && !turn.last?.failed && turn.last?.content === AFTER_TOOL,
        show(turn.last),
      );
      return;
    }

    console.log('\n1. доверенная папка, правки выключены, простой вопрос');
    const plain = await ask(trusted, false, 'QA_PLAIN как дела');
    check(
      `ответ — ровно текст модели, без служебного вывода CLI`,
      plain.last?.role === 'assistant' &&
        !plain.last?.failed &&
        plain.last?.content === REPLY &&
        !CHROME.test(String(plain.last?.content)),
      show(plain.last),
    );
    check(
      `запрос ушёл заглушке: ${plain.requests[0]?.path ?? '—'}`,
      plain.requests.length >= 1 &&
        plain.requests.every(
          (hit) => hit.path.startsWith(`/v1beta/models/${MODEL}:`) && hit.key === SENTINEL,
        ),
      show(plain.requests),
    );

    console.log('\n2. правки выключены (в настройках CLI — auto_edit), модель просит write_file');
    const denied = await ask(trusted, false, 'QA_WRITE запиши файл');
    const deniedTools = denied.requests[0]?.tools ?? [];
    check(
      `файл не тронут (${TARGET})`,
      !existsSync(join(trusted, TARGET)),
      String(stand.read(join(trusted, TARGET))),
    );
    check(
      `CLI не объявил модели инструментов записи (${deniedTools.length} объявлено)`,
      deniedTools.length > 0 &&
        !deniedTools.some((name) => /^(write_file|replace|run_shell_command)$/.test(name)),
      deniedTools.join(', '),
    );
    check(
      'ход дошёл до конца: ответ после отказа инструмента',
      denied.last?.role === 'assistant' &&
        !denied.last?.failed &&
        denied.last?.content === AFTER_TOOL,
      show(denied.last),
    );

    console.log('\n3. правки включены, модель просит write_file');
    const allowed = await ask(trusted, true, 'QA_WRITE запиши файл');
    const allowedTools = allowed.requests[0]?.tools ?? [];
    check(
      'файл записан инструментом CLI',
      stand.read(join(trusted, TARGET)) === WRITTEN,
      String(stand.read(join(trusted, TARGET))),
    );
    check(
      'режим yolo: объявлены и запись, и оболочка (auto_edit оболочку не объявляет)',
      allowedTools.includes('write_file') && allowedTools.includes('run_shell_command'),
      allowedTools.join(', '),
    );
    check(
      'ответ после инструмента — ровно текст модели',
      allowed.last?.role === 'assistant' &&
        !allowed.last?.failed &&
        allowed.last?.content === AFTER_TOOL &&
        !CHROME.test(String(allowed.last?.content)),
      show(allowed.last),
    );

    console.log('\n4. недоверенная папка, правки включены');
    const refused = await ask(untrusted, true, 'QA_WRITE запиши файл');
    check(
      'отказ CLI виден в разговоре, а не подменён ответом',
      refused.last?.role === 'assistant' &&
        refused.last?.failed === true &&
        /trusted directory/i.test(String(refused.last?.content)),
      show(refused.last),
    );
    check(
      `до модели не дошло ни одного запроса (${refused.requests.length})`,
      refused.requests.length === 0,
      show(refused.requests),
    );
    check('файл в недоверенной папке не появился', !existsSync(join(untrusted, TARGET)));

    console.log('\nграницы');
    const leaked = offBox().filter((hit) => JSON.stringify(hit).includes(SENTINEL));
    console.log(
      `  вне машины: ${offBox().length} запрос(ов) ${offBox()
        .map((hit) => hit.url.replace(/\?.*$/, ''))
        .join(', ')}`,
    );
    check(
      'метка ключа не ушла за пределы машины',
      leaked.length === 0,
      leaked.map((hit) => hit.url).join('; '),
    );
    const realDiff = diffRealProviderDirs(realBefore, snapshotRealProviderDirs());
    check(
      `настоящие каталоги CLI человека не тронуты (${realDiff.length})`,
      realDiff.length === 0,
      realDiff
        .slice(0, 10)
        .map((item) => item.path)
        .join('; '),
    );
  },
);
