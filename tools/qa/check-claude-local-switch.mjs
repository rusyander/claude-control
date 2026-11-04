/**
 * «Claude Code на этой модели» (раздел «Локальные модели») — на одноразовом
 * стенде, через настоящий UI, настоящий `claude` и настоящий сервер моделей.
 * Модель держит ЯДРО стенда (удержание `local:own`, этап 10); адрес для CLI —
 * постоянный порт ядра, здесь — свободный порт проверки (порт продукта 11435
 * занят панелью человека и не трогается).
 *
 * 1. Карточка агентов показывает галочку, она доступна (модель скачана).
 * 2. Щелчок: `settings.json` стенда получает постоянный адрес ядра и модель
 *    для всех ролей; подпись «Включено».
 * 3. Настоящий `claude -p` (терминал) с каталогом стенда отвечает, и ответ
 *    пришёл от сервера ядра: модель загружена в нём (`GET /models` маршрутизатора).
 * 4. Чат панели (`/chat/send`) отвечает тем же путём.
 * 5. Щелчок обратно: `settings.json` ровно тот, что был до включения.
 *
 * Сборка llama.cpp — настоящая (`.local-models/runtime`, через `LLAMA_SERVER_BINARY`),
 * файл модели — жёсткая ссылка во временный каталог раздела (удаление ссылки файл
 * не трогает), состояние раздела — своё временное: выбор квантования берётся из
 * настоящего `state.json`, сам он не меняется. Нужна скачанная модель
 * `LOCAL_SWITCH_TAG` (по умолчанию qwen3.8:27b). `~/.claude` человека не трогается.
 *
 * ЗАМОК: грузит модель ~17 ГБ в видеопамять. Без `ALLOW_LOCAL_MODEL=1` —
 * «не проверено», код 2. После прогона сервер снимается, видеопамять
 * печатается (протокол владельца).
 *
 * Запуск: ALLOW_LOCAL_MODEL=1 node tools/qa/check-claude-local-switch.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { freePort, NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = await freePort();
const IS_WIN = process.platform === 'win32';

if (process.env.ALLOW_LOCAL_MODEL !== '1') {
  console.log('Не проверено: нужен ALLOW_LOCAL_MODEL=1 (грузит локальную модель в видеопамять).');
  process.exit(2);
}
const REAL_ROOT = join(REPO, '.local-models');
const REAL_RUNTIME = join(REAL_ROOT, 'runtime');
const REAL_STATE = join(REAL_ROOT, 'state.json');
const model = process.env.LOCAL_SWITCH_TAG || 'qwen3.8:27b';
const realState = existsSync(REAL_STATE) ? JSON.parse(readFileSync(REAL_STATE, 'utf8')) : {};
const catalog = JSON.parse(
  readFileSync(join(REPO, 'apps/server/src/domains/local-models/data/catalog.json'), 'utf8'),
);
const entry = catalog.models.find((item) => item.tag === model);
const quant = entry?.quants.find(
  (item) => item.id === (realState.choices?.[model]?.quant ?? entry.defaultQuant),
);
const source =
  entry && quant ? join(REAL_ROOT, 'models', ...entry.repo.split('/'), quant.file) : '';
const build = existsSync(REAL_RUNTIME)
  ? readdirSync(REAL_RUNTIME)
      .filter((name) => /^llama-b\d+$/.test(name))
      .sort()
      .at(-1)
  : undefined;
const binary = build ? join(REAL_RUNTIME, build, IS_WIN ? 'llama-server.exe' : 'llama-server') : '';
if (!source || !existsSync(source) || !existsSync(binary)) {
  console.log(
    `Не проверено: нет собранного llama.cpp (${binary || REAL_RUNTIME}) или скачанной модели ${model} (${source || 'не в каталоге'}).`,
  );
  process.exit(2);
}

/** Каталог настоящего `claude` (CLAUDE_CLI — путь к нему). */
function claudeDir() {
  if (process.env.CLAUDE_CLI) return dirname(process.env.CLAUDE_CLI);
  const found = spawnSync(IS_WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const first = found.stdout?.split(/\r?\n/).find(Boolean);
  if (!first) {
    console.log('Не проверено: claude нет в PATH.');
    process.exit(2);
  }
  return dirname(first);
}

const vram = () => {
  try {
    return execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'nvidia-smi недоступен';
  }
};
/** Модели маршрутизатора за постоянным адресом: `{ data: [{ id, status: { value } }] }`. */
const loadedModels = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/models`);
    if (!res.ok) return undefined;
    const body = await res.json();
    return (body.data ?? [])
      .filter((item) => item.status?.value === 'loaded')
      .map((item) => item.id);
  } catch {
    return undefined;
  }
};

/** Протокол владельца: снять сервер (память возвращается с процессом), показать видеопамять. */
async function releaseGpu() {
  if (stand)
    await stand.api('/local-models/server/stop', { method: 'POST' }).catch(() => undefined);
  await wait(2500);
  const left = await loadedModels();
  console.log(
    `  сервер моделей после остановки: ${left?.length ? 'ЕЩЁ ДЕРЖИТ МОДЕЛЬ' : 'модели нет'}`,
  );
  console.log(`  видеопамять после: ${vram()}`);
}

const localRoot = mkdtempSync(join(tmpdir(), 'cc-local-switch-'));
// Жёсткая ссылка на настоящий файл модели: гигабайты не копируются, удаление ссылки файл не трогает.
const linked = join(localRoot, 'models', ...entry.repo.split('/'), quant.file);
mkdirSync(dirname(linked), { recursive: true });
linkSync(source, linked);
// Состояние раздела своё: выбор квантования — как у человека, отметка «Claude уведён» — только здесь.
writeFileSync(
  join(localRoot, 'state.json'),
  JSON.stringify({ choices: { [model]: { quant: quant.id, context: 32_768 } } }),
);
// Стенд не наследует AGENTDECK_* (увели бы его в каталоги человека) — только явным env.
const realStateBefore = existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null;
console.log(`Модель: ${model}; видеопамять до: ${vram()}`);

const { check, failed } = reporter();
let stand;
let browser;
let project;
let skipped = false;
try {
  // Стенд вырезает `claude` из PATH; здесь нужен настоящий — каталог в конец PATH.
  stand = await startStand({
    label: 'local-switch-stand',
    extraPath: [claudeDir()],
    core: true,
    env: {
      AGENTDECK_LOCAL_MODELS_DIR: localRoot,
      AGENTDECK_LOCAL_FRONT_PORT: String(PORT),
      LLAMA_SERVER_BINARY: binary,
    },
  });
  {
    const settingsPath = join(stand.cfg, 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');
    browser = await chromium.launch();
    const page = await stand.newPage(browser);
    // Галочка — на вкладке «Агентам»: на других вкладках раздела её нет.
    await page.goto(`${stand.webUrl}/local-models?tab=agents`, { waitUntil: 'domcontentloaded' });
    const toggle = page.getByLabel('Claude Code на этой модели');
    await toggle.first().waitFor({ timeout: 30_000 });
    check('галочка «Claude Code на этой модели» есть', (await toggle.count()) === 1);
    check('галочка доступна (модель скачана)', await toggle.isEnabled());
    check('по умолчанию выключена', !(await toggle.isChecked()));

    await toggle.click();
    // Включение поднимает сервер моделей — это минуты на холодном старте.
    const on = page.getByText('Включено: Claude Code работает на', { exact: false });
    await on.waitFor({ timeout: 300_000 }).catch(() => undefined);
    check(
      'подпись «Включено»',
      await on.isVisible(),
      (await page.locator('main').innerText()).slice(0, 600),
    );
    const env = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
    check(
      `settings.json: адрес сервера моделей :${PORT}`,
      String(env.ANTHROPIC_BASE_URL).includes(`:${PORT}`),
      JSON.stringify(env),
    );
    check(
      'settings.json: модель для всех ролей',
      env.ANTHROPIC_MODEL === model && env.ANTHROPIC_DEFAULT_SONNET_MODEL === model,
      JSON.stringify(env),
    );

    // Терминал: настоящий `claude` на каталоге стенда.
    const word = `PONG${Math.floor(Math.random() * 9000 + 1000)}`;
    // Промпт — через stdin: `.cmd` под `shell` склеивает аргументы, и фраза с
    // пробелами доходила до CLI одним первым словом.
    const cli = spawnSync('claude', ['-p'], {
      cwd: stand.root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: stand.cfg },
      input: `Reply with exactly this word and nothing else: ${word}`,
      encoding: 'utf8',
      shell: IS_WIN,
      timeout: 300_000,
    });
    check(
      'терминал: claude -p ответил словом',
      cli.stdout?.includes(word),
      `${cli.status} ${cli.stdout?.slice(0, 300)} ${cli.stderr?.slice(0, 300)}`,
    );
    const served = await loadedModels();
    // Список маршрутизатора llama.cpp (сборка 11583) пишет метку размера заглавными: `qwen3.8:27B` —
    // та же модель (ядро сопоставляет так же, `apps/core/src/routes/local/own/model-id.ts`).
    const sameModel = (id) => typeof id === 'string' && id.toLowerCase() === model.toLowerCase();
    check(
      'ответ дал сервер ядра: модель загружена в нём',
      served?.some(sameModel) === true,
      JSON.stringify(served ?? null),
    );

    // Чат панели: ответ на отправку — поток прогона до конца.
    const chatWord = `CHAT${Math.floor(Math.random() * 9000 + 1000)}`;
    project = mkdtempSync(join(tmpdir(), 'cc-local-switch-project-'));
    const sent = await stand.api('/chat/send', {
      method: 'POST',
      body: {
        chatId: crypto.randomUUID(),
        prompt: `Reply with exactly this word and nothing else: ${chatWord}`,
        projectPath: project,
      },
    });
    // Поток SSE: текст идёт кусками (`kind: text`), модель — в `kind: usage`.
    const events = sent.text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return {};
        }
      });
    const reply = events
      .filter((event) => event.kind === 'text')
      .map((event) => event.text)
      .join('');
    check('чат панели: ответ словом', reply.includes(chatWord), reply.slice(0, 300));
    const finished = events.find((event) => event.kind === 'done');
    // CLI считает чужую модель по тарифу Claude (11.10: $0.19) — панель это гасит.
    check(
      'чат панели: итог хода без выдуманной цены',
      finished?.costUsd === 0,
      JSON.stringify(finished ?? null),
    );
    const usage = events.find((event) => event.kind === 'usage');
    check(
      'чат панели: ход сделала локальная модель',
      // Строго имя человека: фронт ядра возвращает имя запроса (траты и каталог считают по нему).
      usage?.model === model,
      JSON.stringify(usage ?? null),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await toggle.first().waitFor({ timeout: 30_000 });
    check('после перезагрузки галочка включена', await toggle.isChecked());
    await toggle.click();
    const off = page.getByText('Выключено: Claude Code работает как обычно');
    await off.waitFor({ timeout: 60_000 }).catch(() => undefined);
    check('подпись «Выключено»', await off.isVisible());
    check('галочка снята', !(await toggle.isChecked()));
    check(
      'выключение: settings.json как до включения',
      readFileSync(settingsPath, 'utf8') === before,
      readFileSync(settingsPath, 'utf8'),
    );
  }
} catch (error) {
  if (error instanceof NotChecked) {
    skipped = true;
    console.log(`Не проверено: ${error.message}`);
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
    if (stand)
      console.log(`
Журнал панели (хвост):
${stand.log().slice(-3000)}`);
  }
} finally {
  if (browser) await browser.close();
  // Сервер моделей, поднятый панелью стенда, держит каталог стенда: сперва он.
  await releaseGpu();
  if (stand) await stand.stop().catch((error) => console.log(`  ! стенд: ${error.code ?? error}`));
  // Файл модели здесь — жёсткая ссылка: удаление каталога убирает ссылку, настоящий файл остаётся.
  rmSync(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  check('настоящий файл модели на месте после уборки', existsSync(source), source);
  if (project) {
    try {
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.log(`  ! каталог проекта не удалён: ${project} (${error.code})`);
    }
  }
}
// Сторож: состояние раздела у стенда человека не тронуто.
check(
  'настоящий .local-models/state.json не изменился',
  (existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null) === realStateBefore,
);
if (skipped) process.exit(2);
console.log(failed() === 0 ? '\nВсё сходится.' : `\nПровалов: ${failed()}`);
process.exit(failed() === 0 ? 0 : 1);
