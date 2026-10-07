/**
 * «Разрешить правки» и карточка разрешения в чате чужого CLI — настоящими qwen
 * (`qwen serve`) и codex (`codex app-server`) через настоящую панель и фронт.
 * Аргумент — один CLI (`qwen` | `codex`); без аргумента — оба по очереди, каждый
 * своим процессом (так кейс блока «Тесты» гоняет обоих одним файлом).
 *
 * Свой одноразовый стенд (`throwaway-stand.mjs`) с активным CLI и заглушка
 * модели (`stub-steer-model.mjs`), которая первым ответом зовёт инструмент
 * оболочки строкой, пишущей файл в каталог разговора. Сценарии — путь человека:
 *   1. переключатель выключен, вкладка вернулась (F5) — карточка из статуса,
 *      «Разрешить» → файл записан;
 *   2. переключатель выключен, вопрос из открытой вкладки — карточка приходит
 *      потоком, «Запретить» → файла нет;
 *   3. переключатель включён в шапке — карточки нет, файл записан.
 * Доказательство — файл на диске, а не текст ответа.
 *
 * Подменена только модель (сетевая граница). CLI — настоящий: из
 * `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH. Нет его —
 * «не проверено» (код 2), не провал. Дом CLI — временный каталог.
 *
 * Код выхода: 0 — всё сходится, 1 — провал, 2 — не проверено (у обоих: провал
 * важнее, «не проверено» хоть одного — 2).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { NotChecked, REPO, reporter, startStand, wait } from './throwaway-stand.mjs';
import { startStubModel } from './stub-steer-model.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const IS_WIN = process.platform === 'win32';
const SHOTS = join(REPO, '.agent', 'screenshots', 'foreign-permissions');

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/**
 * PID процессов, в командной строке которых есть один из каталогов. Стенд снимает
 * панель жёстко: сервер CLI и его дети (у codex — `git`, клонирующий плагины в
 * `CODEX_HOME/.tmp`) переживают проверку и держат временный каталог (EPERM).
 * Снимаем ровно то, чего до прогона не было.
 */
function processesUnder(dirs) {
  const norm = (text) => text.toLowerCase().replace(/[\\/]+/g, '/');
  // `tmpdir()` на Windows — короткое имя (`RUSYAN~1`), а в командной строке `git`
  // стоит длинное: ищем оба.
  const long = (dir) => {
    try {
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  };
  const needles = dirs
    .flatMap((dir) => [dir, long(dir)])
    .map((dir) => norm(dir).replace(/\/+$/, ''));
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return new Set(
      rows
        .split(/\r?\n/)
        .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
        .filter((match) => match && needles.some((needle) => norm(match[2]).includes(needle)))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

function reap(before, dirs) {
  for (const pid of processesUnder(dirs)) {
    if (before.has(pid) || pid === process.pid) continue;
    try {
      process.kill(pid);
    } catch {
      // уже вышел
    }
  }
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

/** Окружение CLI на стенд: адрес заглушки и временный дом (как в `check-foreign-steer.mjs`). */
const CLIS = {
  qwen: (root, base) => {
    const home = join(root, 'qwen-home');
    mkdirSync(home, { recursive: true });
    return {
      QWEN_HOME: home,
      OPENAI_BASE_URL: `${base}/v1`,
      OPENAI_API_KEY: 'x',
      OPENAI_MODEL: 'stub-model',
    };
  },
  codex: (root, base) => {
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.toml'),
      [
        'model_provider = "stub"',
        'model = "stub-model"',
        '[model_providers.stub]',
        'name = "stub"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        'env_key = "STUB_KEY"',
        '',
      ].join('\n'),
    );
    return { CODEX_HOME: home, STUB_KEY: 'x' };
  },
};

if (!process.argv[2]) {
  const codes = Object.keys(CLIS).map((cli) => {
    console.log(`\n=== ${cli} ===`);
    return spawnSync(process.execPath, [fileURLToPath(import.meta.url), cli], { stdio: 'inherit' })
      .status;
  });
  if (codes.includes(1) || codes.includes(null)) process.exit(1);
  process.exit(codes.includes(2) ? 2 : 0);
}
const CLI = process.argv[2];
if (!CLIS[CLI]) {
  console.log(`Неизвестный CLI «${CLI}»: ${Object.keys(CLIS).join(', ')}`);
  process.exit(1);
}
const { check, finish } = reporter();
const cliDir = findCli(CLI);
if (!cliDir) {
  console.log(`Не проверено: ${CLI} нет ни в STEER_CLI_DIR, ни в PATH.`);
  process.exit(2);
}

const PROBE = 'probe-edit.txt';
// Строка для оболочки, которой CLI исполняет команду: qwen на Windows — cmd, codex —
// PowerShell, а в нём `echo a>f` в кавычках `-Command '…'` печатается, а не пишется.
const TOOL_LINE = {
  qwen: `echo edited>${PROBE}`,
  codex: IS_WIN ? `Set-Content ${PROBE} edited` : `echo edited > ${PROBE}`,
};
const stub = await startStubModel({
  marker: 'never-steered',
  holdMs: 300,
  toolLine: TOOL_LINE[CLI],
});
const root = mkdtempSync(join(tmpdir(), 'cc-fperm-'));
const before = processesUnder([cliDir, root]);
const saved = {};
const added = {
  ...CLIS[CLI](root, `http://127.0.0.1:${stub.port}`),
  PATH: `${cliDir}${delimiter}${process.env.PATH ?? ''}`,
};
for (const key of Object.keys(added)) saved[key] = process.env[key];
Object.assign(process.env, added);
const shots = join(SHOTS, CLI);
mkdirSync(shots, { recursive: true });

let stand;
let browser;
let exitCode;
try {
  stand = await startStand({ label: `foreign-perms-${CLI}`, settings: { provider: CLI } });
  console.log(`Одноразовая панель ${stand.apiUrl}, фронт ${stand.webUrl}\n`);
  browser = await chromium.launch();
  const page = await stand.newPage(browser);
  await bypassOnboarding(page, { provider: CLI });

  const project = (name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const newChat = async (dir) => {
    const created = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { workdir: dir },
    });
    if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
    return created.body.id;
  };
  const status = async (id) => (await stand.api(`/provider-chat/chats/${id}/status`)).body;
  const ended = (id) => until(async () => (await status(id))?.isRunning === false, 120);
  const card = () => page.getByText('Агент просит разрешение');
  const openChat = async (title) => {
    await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: false }).first().click({ timeout: 60_000 });
  };

  // 1. Выключено, вкладка вернулась: карточка из статуса, «Разрешить» → файл есть.
  console.log('1. Разрешить (вкладка вернулась)');
  const dirAllow = project('allow');
  const allowId = await newChat(dirAllow);
  const sent = await stand.api(`/provider-chat/chats/${allowId}/send`, {
    method: 'POST',
    body: { text: 'Запиши файл, пожалуйста.' },
  });
  check('вопрос принят', sent.status === 200, sent.text);
  const asked = await until(async () => (await status(allowId))?.permissions?.[0], 120);
  check(
    `просьба ${CLI} дошла до хранилища панели`,
    Boolean(asked),
    JSON.stringify(await status(allowId)),
  );
  check('файла до решения нет', !existsSync(join(dirAllow, PROBE)));
  await openChat('Запиши файл');
  const shown = await card()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('карточка в ленте после возврата на страницу', shown);
  await page.screenshot({ path: join(shots, '1-card.png') });
  await page.getByRole('button', { name: 'Разрешить', exact: true }).click();
  check('ход кончился', Boolean(await ended(allowId)));
  check(`«Разрешить» → ${CLI} записал файл`, existsSync(join(dirAllow, PROBE)));
  check(
    'карточка снята',
    await card()
      .waitFor({ state: 'detached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false),
  );

  // 2. Выключено, открытая вкладка: карточка потоком, «Запретить» → файла нет.
  console.log('\n2. Запретить (вопрос из открытой вкладки)');
  const dirDeny = project('deny');
  const denyId = await newChat(dirDeny);
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Новый разговор').first().click({ timeout: 60_000 });
  const box = page.locator('textarea').last();
  await box.fill('Попробуй записать файл.');
  await box.press('Enter');
  const streamed = await card()
    .waitFor({ timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  check('карточка пришла потоком в открытую вкладку', streamed);
  await page.getByRole('button', { name: 'Запретить', exact: true }).click();
  check('ход кончился', Boolean(await ended(denyId)));
  check('«Запретить» → файла нет', !existsSync(join(dirDeny, PROBE)));

  // 3. Переключатель в шапке включён: карточки нет, файл есть.
  console.log('\n3. Переключатель «Правки без вопроса»');
  const dirOn = project('on');
  const onId = await newChat(dirOn);
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Новый разговор').first().click({ timeout: 60_000 });
  const toggle = page.getByLabel('Разрешить правки без вопроса');
  await toggle.click({ timeout: 30_000 });
  const patched = await until(
    async () => (await stand.api(`/provider-chat/chats/${onId}`)).body?.allowEdits === true,
    20,
  );
  check('переключатель записан в шапку разговора', Boolean(patched));
  await page.screenshot({ path: join(shots, '3-toggle-on.png') });
  const box3 = page.locator('textarea').last();
  await box3.fill('Запиши файл без вопросов.');
  await box3.press('Enter');
  await wait(1500);
  check('ход кончился', Boolean(await ended(onId)));
  check('включено → файл записан без карточки', existsSync(join(dirOn, PROBE)));
  check('карточки не было', (await card().count()) === 0);
  check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    exitCode = 2;
  } else check('сценарий дошёл до конца', false, error?.stack ?? String(error));
} finally {
  if (browser) await browser.close();
  if (stand) await stand.stop();
  reap(before, [cliDir, root, ...(stand ? [stand.root] : [])]);
  await stub.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await wait(500);
  if (stand) rmSync(stand.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
if (exitCode !== undefined) process.exit(exitCode);
finish();
