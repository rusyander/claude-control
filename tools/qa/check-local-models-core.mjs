/**
 * «Локальные модели» на ядре (этап 10, зона C) — настоящая дорога на одноразовом стенде: панель и
 * ядро — свои процессы, «Запустить» раздела — это удержание `local:own` ядра, адрес для CLI
 * человека — постоянный порт ядра (здесь — свободный порт проверки, порт продукта 11435 не трогается).
 *
 * Что проверяется:
 * 1. Переключение с прежней панели: llama-server, поднятый ещё ею (отдельный процесс + запись
 *    `run/llama.json`), держит постоянный порт и отвечает CLI. «Запустить» снимает его, порт берёт
 *    ядро, ответ через тот же адрес — 200 уже от сервера ядра.
 * 2. Переключатель Claude: `settings.json` стенда указывает на постоянный порт, `/v1/messages` по
 *    этому адресу с ключом из настройки — 200, второй загрузки нет; выключение возвращает настройку.
 * 3. «Остановить» — сервер снят, порт отвечает 404 на пробу (не 503 «грузится») и 503
 *    `local_not_held` на модельный путь.
 *
 * Сервер моделей по умолчанию — подставной маршрутизатор ядра (`fake-router.mjs`: те же аргументы и
 * пути, что у llama-server; раннер — заглушка `packages/stub-model`) через `LLAMA_SERVER_BINARY`;
 * видеопамять читается настоящая, раннер её не занимает.
 *
 * `REAL_LLAMA=1 ALLOW_LOCAL_MODEL=1` — настоящий llama-server панели (`.local-models/runtime`) и
 * настоящая модель (`REAL_LLAMA_TAG`, по умолчанию qwen3.8:27b): файл модели — жёсткая ссылка во
 * временный каталог (удаление ссылки файл не трогает). Грузит ~17 ГБ в видеопамять; печатает её до,
 * во время и после, а также факты маршрутизатора (`/props?model=`, журнал `log-file`).
 *
 * Запуск: `node tools/qa/check-local-models-core.mjs` (стенд свой, `pnpm dev` не нужен).
 * Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся или настоящий режим без разрешения.
 */
import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGguf } from './stub-llama.mjs';
import { freePort, runOnStand } from './throwaway-stand.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const IS_WIN = process.platform === 'win32';
const REAL = process.env.REAL_LLAMA === '1';
const ROUTER = join(REPO, 'apps/core/src/routes/local/own/__fixtures__/fake-router.mjs');
const STUB_LLAMA = join(REPO, 'tools/qa/stub-llama.mjs');
const catalog = JSON.parse(
  readFileSync(join(REPO, 'apps/server/src/domains/local-models/data/catalog.json'), 'utf8'),
);

if (REAL && process.env.ALLOW_LOCAL_MODEL !== '1') {
  console.log(
    'Не проверено: настоящий режим грузит модель в видеопамять — нужен ALLOW_LOCAL_MODEL=1.',
  );
  process.exit(2);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const vram = () => {
  try {
    return execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader'],
      {
        encoding: 'utf8',
      },
    ).trim();
  } catch {
    return 'nvidia-smi недоступен';
  }
};

const work = mkdtempSync(join(tmpdir(), 'cc-local-core-bin-'));
const lmDir = join(work, 'lm');
const vramDir = join(work, 'fake-vram');

/** Модель проверки, её файл и сервер моделей — подставные или настоящие. */
function setup() {
  if (REAL) {
    const tag = process.env.REAL_LLAMA_TAG || 'qwen3.8:27b';
    const realRoot = join(REPO, '.local-models');
    const choice =
      JSON.parse(readFileSync(join(realRoot, 'state.json'), 'utf8')).choices?.[tag] ?? {};
    const entry = catalog.models.find((item) => item.tag === tag);
    const quant = entry?.quants.find((item) => item.id === (choice.quant ?? entry.defaultQuant));
    const runtime = join(realRoot, 'runtime');
    const build = existsSync(runtime)
      ? readdirSync(runtime)
          .filter((name) => /^llama-b\d+$/.test(name))
          .sort()
          .at(-1)
      : undefined;
    const binary = build ? join(runtime, build, IS_WIN ? 'llama-server.exe' : 'llama-server') : '';
    const source =
      entry && quant ? join(realRoot, 'models', ...entry.repo.split('/'), quant.file) : '';
    if (!entry || !quant || !existsSync(source) || !existsSync(binary)) {
      console.log(
        `Не проверено: нет модели ${tag} (${source || 'не в каталоге'}) или сборки (${binary || runtime}).`,
      );
      process.exit(2);
    }
    const file = join(lmDir, 'models', ...entry.repo.split('/'), quant.file);
    mkdirSync(join(file, '..'), { recursive: true });
    // Жёсткая ссылка: гигабайты не копируются, а удаление временного каталога файл не трогает.
    linkSync(source, file);
    // Окно поменьше выбора человека: проверяется дорога, а не предел карты.
    writeFileSync(
      join(lmDir, 'state.json'),
      JSON.stringify({ choices: { [tag]: { quant: quant.id, context: 16_384 } } }),
    );
    return { tag, file, binary, source };
  }
  const entry = catalog.models.find((item) => item.tag === 'qwen3.5:4b');
  const quant = entry?.quants.find((item) => item.id === entry.defaultQuant);
  if (!entry || !quant) throw new Error('qwen3.5:4b нет в каталоге');
  const file = join(lmDir, 'models', ...entry.repo.split('/'), quant.file);
  // Модель «скачана»: настоящий заголовок GGUF там, где её ищет библиотека панели.
  writeGguf(file, { arch: 'qwen35' });
  // Обёртка над подставным маршрутизатором; его раннеры отмечают «память» в своём каталоге.
  const entryScript = join(work, 'fake-router.mjs');
  writeFileSync(
    entryScript,
    `#!/usr/bin/env node\nimport { mkdirSync } from 'node:fs';\nprocess.env.FAKE_VRAM_DIR = ${JSON.stringify(vramDir)};\nmkdirSync(process.env.FAKE_VRAM_DIR, { recursive: true });\nawait import(${JSON.stringify(pathToFileURL(ROUTER).href)});\n`,
  );
  let binary = entryScript;
  if (IS_WIN) {
    // Форма обёртки, которую ядро разбирает без cmd.exe (win-shim LEGACY): node + скрипт рядом.
    binary = join(work, 'llama-server.cmd');
    writeFileSync(binary, `@echo off\r\nnode  "%~dp0\\fake-router.mjs" %*\r\n`);
  } else {
    chmodSync(entryScript, 0o755);
  }
  return { tag: entry.tag, file, binary, source: '' };
}

const { tag: TAG, file: MODEL_FILE, binary: BINARY, source: REAL_SOURCE } = setup();
const port = await freePort();
// 5170–5180 — порты живого стенда человека; ОС их не выдаёт, но проверка на это не полагается.
if (port >= 5170 && port <= 5180) throw new Error(`порт ${port} — порт живого стенда`);
const frontUrl = `http://127.0.0.1:${port}`;

/** Раннеры подставного маршрутизатора, чей процесс жив (файл `<pid>.json` в каталоге «памяти»). */
function liveRunners() {
  if (REAL || !existsSync(vramDir)) return [];
  return readdirSync(vramDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => Number(name.slice(0, -5)))
    .filter((pid) => alive(pid));
}

async function until(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await wait(200);
  }
  return undefined;
}

async function hit(url, init) {
  try {
    const res = await fetch(url, init);
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: String(error?.cause?.code ?? error) };
  }
}

const messages = (base, headers = {}) =>
  hit(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: TAG,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with one word: hi' }],
    }),
  });
/** Ответ модели ядра: подставной раннер пишет свой текст, настоящая модель — сообщение Anthropic. */
const fromCoreModel = (reply) =>
  reply.status === 200 &&
  (REAL ? reply.text.includes('"type":"message"') : reply.text.includes('function merge'));
const health = () => hit(`${frontUrl}/health`);

// Прежний llama-server панели: отдельный процесс на постоянном порту (заглушка llama-server).
const previousScript = join(work, 'previous-server.mjs');
writeFileSync(
  previousScript,
  `import { startStubLlama } from ${JSON.stringify(pathToFileURL(STUB_LLAMA).href)};\nawait startStubLlama({ port: ${port}, alias: 'previous-panel-server' });\nconsole.log('UP');\nsetInterval(() => {}, 60_000);\n`,
);
const previousStartedAt = Date.now();
const previous = spawn(process.execPath, [previousScript], {
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
await new Promise((done) => previous.stdout.once('data', done));
// Запись прежней панели: номер процесса, порт, файл модели, время запуска (личность процесса).
mkdirSync(join(lmDir, 'run'), { recursive: true });
writeFileSync(
  join(lmDir, 'run', 'llama.json'),
  JSON.stringify({
    tag: TAG,
    file: MODEL_FILE,
    quant: 'previous',
    context: 4096,
    pid: previous.pid,
    port,
    binary: 'llama-server',
    startedAt: previousStartedAt,
  }),
);

/** pid сервера удержания из зеркала панели (`run/llama.json`). */
const heldPid = () => {
  try {
    return JSON.parse(readFileSync(join(lmDir, 'run', 'llama.json'), 'utf8')).pid;
  } catch {
    return 0;
  }
};
// `runOnStand` завершает процесс сам — уборка на выходе. Сервер удержания ядро держит отвязанным
// (он переживает перезапуск ядра), снятие стенда его не уносит: проверка снимает то, что подняла.
process.once('exit', () => {
  for (const pid of [heldPid(), previous.pid, ...liveRunners()]) {
    if (pid && alive(pid)) process.kill(pid);
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (REAL) console.log(`  файл модели после уборки на месте: ${existsSync(REAL_SOURCE)}`);
});

if (REAL) console.log(`Модель ${TAG}; видеопамять до: ${vram()}`);

await runOnStand(
  {
    label: 'local-core',
    web: false,
    core: true,
    env: {
      AGENTDECK_LOCAL_FRONT_PORT: String(port),
      AGENTDECK_LOCAL_MODELS_DIR: lmDir,
      LLAMA_SERVER_BINARY: BINARY,
    },
  },
  async (stand, check) => {
    let stopped = false;
    try {
      // 1. До переключения CLI говорит с прежним сервером: ядро порт не отбирает, а ждёт.
      await wait(1_500);
      const before = await messages(frontUrl);
      const beforeProps = await hit(`${frontUrl}/props`);
      check(
        'до переключения: постоянный порт отвечает прежним сервером (запрос CLI — 200)',
        before.status === 200 && beforeProps.text.includes('previous-panel-server'),
        `${before.status} ${beforeProps.text.slice(0, 200)}`,
      );

      // Срок ответа: подставной раннер грузится за секунды, настоящая модель — за минуту-две. Без срока
      // порт, который так и не перешёл к ядру, держал бы проверку до таймаута панели (5 минут) — зависание, а не отказ.
      const startBudgetMs = REAL ? 240_000 : 45_000;
      const started = await stand
        .api('/local-models/server/start', {
          method: 'POST',
          body: { tag: TAG },
          signal: AbortSignal.timeout(startBudgetMs),
        })
        .catch((error) => ({
          status: 0,
          text: `не ответил за ${startBudgetMs / 1000} с: ${error instanceof Error ? error.message : String(error)}`,
        }));
      check(
        '«Запустить» — 200',
        started.status === 200,
        `${started.status} ${started.text.slice(0, 400)}\n${stand.coreLog().slice(-1500)}`,
      );
      check('прежний сервер панели снят', !alive(previous.pid), `pid ${previous.pid} жив`);
      const through = await messages(frontUrl);
      check(
        'после переключения: тот же адрес — 200 от сервера ядра',
        fromCoreModel(through),
        `${through.status} ${through.text.slice(0, 300)}`,
      );
      if (!REAL)
        check('раннер жив ровно один', liveRunners().length === 1, JSON.stringify(liveRunners()));
      // Запуск не состоялся — дальше нечего проверять: переключатель и «Остановить» встали бы в очередь
      // панели за брошенным запуском, и проверка висела бы вместо отказа.
      if (started.status !== 200) return;
      if (REAL) {
        console.log(`  видеопамять с моделью: ${vram()}`);
        const props = await hit(`${frontUrl}/props?model=${encodeURIComponent(TAG)}`);
        const bare = await hit(`${frontUrl}/props`);
        console.log(`  /props?model= → ${props.status}; /props без модели → ${bare.status}`);
        const parsed = (() => {
          try {
            return JSON.parse(props.text);
          } catch {
            return {};
          }
        })();
        console.log(
          `  шаблон чата: ${parsed.chat_template ? `есть (${String(parsed.chat_template).length} симв.)` : 'нет'}; jinja: ${JSON.stringify(parsed.jinja ?? parsed.use_jinja ?? null)}`,
        );
        const log = join(lmDir, 'logs', 'llama.log');
        check(
          'пресет `log-file`: журнал модели пишется в файл раздела',
          existsSync(log) && statSync(log).size > 0,
          existsSync(log) ? 'пустой' : 'нет файла',
        );
      }

      // 2. Переключатель Claude — на постоянный порт.
      const settingsPath = join(stand.cfg, 'settings.json');
      const settingsBefore = readFileSync(settingsPath, 'utf8');
      const on = await stand.api('/local-models/claude', {
        method: 'PUT',
        body: { on: true, tag: TAG },
      });
      check(
        'переключатель Claude включён — 200',
        on.status === 200,
        `${on.status} ${on.text.slice(0, 300)}`,
      );
      const env = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
      check(
        `settings.json: ANTHROPIC_BASE_URL = ${frontUrl}`,
        env.ANTHROPIC_BASE_URL === frontUrl,
        JSON.stringify(env),
      );
      const viaSettings = await messages(env.ANTHROPIC_BASE_URL ?? frontUrl, {
        authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN ?? ''}`,
      });
      check(
        'CLI по адресу из settings.json получает ответ модели — 200',
        fromCoreModel(viaSettings),
        `${viaSettings.status} ${viaSettings.text.slice(0, 300)}`,
      );
      if (!REAL)
        check('второй загрузки нет', liveRunners().length === 1, JSON.stringify(liveRunners()));
      const off = await stand.api('/local-models/claude', { method: 'PUT', body: { on: false } });
      check(
        'выключение: settings.json как до включения',
        off.status === 200 && readFileSync(settingsPath, 'utf8') === settingsBefore,
        readFileSync(settingsPath, 'utf8'),
      );

      // 3. «Остановить» — модель выгружена, порт снова отказывает с причиной.
      const servedPid = heldPid();
      const stoppedReply = await stand.api('/local-models/server/stop', { method: 'POST' });
      stopped = stoppedReply.status === 200;
      check(
        '«Остановить» — 200',
        stopped,
        `${stoppedReply.status} ${stoppedReply.text.slice(0, 300)}`,
      );
      const gone = await until(
        async () => liveRunners().length === 0 && !(servedPid && alive(servedPid)),
        15_000,
      );
      check(
        'сервер ядра снят',
        Boolean(gone),
        `runners ${JSON.stringify(liveRunners())}, pid ${servedPid}`,
      );
      const after = await messages(frontUrl);
      check(
        'после остановки: проба 404, модельный путь 503 local_not_held',
        (await health()).status === 404 &&
          after.status === 503 &&
          after.text.includes('local_not_held'),
        `${after.status} ${after.text.slice(0, 200)}`,
      );
      if (REAL) {
        await wait(2_000);
        console.log(`  видеопамять после остановки: ${vram()}`);
      }
    } finally {
      // Провал посреди сценария — модель всё равно снимается кнопкой, а не только на выходе.
      // Срок и здесь: «Запустить», брошенный по сроку, ещё ждёт порт внутри панели, и «Остановить» встал бы
      // за ним в очередь; остальное снимает уборка на выходе.
      if (!stopped)
        await stand
          .api('/local-models/server/stop', { method: 'POST', signal: AbortSignal.timeout(30_000) })
          .catch(() => undefined);
    }
  },
);
