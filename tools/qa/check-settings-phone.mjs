/**
 * Настройки → «Телефон»: APK кнопкой и вопросы с компьютера. API подменено —
 * сборка длится десять минут и пишет файл в репозиторий, а здесь проверяется,
 * что вкладка честно показывает каждое состояние и шлёт серверу то, что нужно.
 * Настоящую сборку кнопкой проверяет человек на стенде; этот скрипт не трогает
 * ни репозиторий, ни adb, ни настройки Claude Code.
 *
 * Строки: сборка не шла; идёт (кнопка закрыта, вывод прокручен вниз); упала;
 * готова, телефон в adb (установка уходит с серийным номером); adb нет; второй
 * запуск — отказ сервера виден; хук не стоит (команда и путь к «Хукам») и
 * стоит; переключатель шлёт PATCH.
 *
 * Нужен стенд фронта (`pnpm dev`; `APP_URL`, по умолчанию :8888). Выход 1 —
 * хоть одна строка FAIL. Кадры — `.agent/screenshots/check-settings-phone/`.
 *
 * Запуск: node tools/qa/check-settings-phone.mjs
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT = join('.agent', 'screenshots', 'check-settings-phone');
await mkdir(OUT, { recursive: true });

const LOG = Array.from({ length: 40 }, (_, i) => `> Task :app:step${i + 1}`);
const FILE = {
  path: 'C:/repo/agentdeck.apk',
  size: 167_453_051,
  builtAt: '2026-10-11T12:22:43.136Z',
};
const base = { available: true, log: [], devices: [], adbMissing: false };
const STATES = {
  idle: { ...base, state: 'idle' },
  building: { ...base, state: 'building', startedAt: '2026-10-11T12:56:52.764Z', log: LOG },
  failed: {
    ...base,
    state: 'failed',
    startedAt: '2026-10-11T12:56:52.764Z',
    finishedAt: '2026-10-11T13:00:00.000Z',
    log: ['> Task :app:assembleRelease', 'BUILD FAILED in 3m'],
  },
  ready: {
    ...base,
    state: 'succeeded',
    finishedAt: '2026-10-11T13:06:00.000Z',
    log: ['BUILD SUCCESSFUL'],
    file: FILE,
    devices: ['emulator-5554'],
  },
  noAdb: { ...base, state: 'succeeded', file: FILE, adbMissing: true },
};
const COMMAND = 'node "C:/repo/outside-relay-hook.mjs" --url http://127.0.0.1:5178';

let apk = STATES.idle;
let relay = { enabled: true, installed: false, shortTimeout: false, command: COMMAND };
let buildBusy = false;
let built = 0;
let installBody;
let relayPatch;

const rows = [];
let bad = 0;
const check = (ok, what, seen = '') => {
  rows.push({ what, seen: String(seen).slice(0, 70), verdict: ok ? 'OK' : 'FAIL' });
  if (!ok) bad += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await bypassOnboarding(page);

await page.route('**/api/mobile/apk', (route) => route.fulfill({ json: apk }));
await page.route('**/api/mobile/apk/build', (route) => {
  built += 1;
  if (buildBusy) return route.fulfill({ status: 409, json: { error: 'busy' } });
  apk = STATES.building;
  return route.fulfill({ json: apk });
});
await page.route('**/api/mobile/apk/install', (route) => {
  installBody = route.request().postDataJSON();
  return route.fulfill({
    json: { ok: true, device: installBody?.device, output: 'Success' },
  });
});
await page.route('**/api/outside/relay', (route) => {
  if (route.request().method() === 'PATCH') {
    relayPatch = route.request().postDataJSON();
    relay = { ...relay, enabled: Boolean(relayPatch?.enabled) };
  }
  return route.fulfill({ json: relay });
});

const open = async (state) => {
  apk = state;
  await page.goto(`${BASE}/settings?tab=phone`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Приложение для телефона').first().waitFor();
  await page.waitForTimeout(400);
};
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

// 1. Сборки не было.
await open(STATES.idle);
check(
  (await page.getByRole('button', { name: 'Собрать APK' }).count()) === 1,
  'не собиралось: кнопка «Собрать APK»',
);
check((await page.getByText('не собиралось').count()) === 1, 'бейдж «не собиралось»');
check((await page.getByText('Скачать APK').count()) === 0, 'без файла ссылки на скачивание нет');
await page.getByRole('button', { name: 'Собрать APK' }).click();
await page.getByText('собирается').first().waitFor({ timeout: 5000 });
check(built === 1, 'клик шлёт POST /mobile/apk/build', `вызовов: ${built}`);

// 2. Идёт сборка: кнопка закрыта, вывод прокручен к последней строке.
await open(STATES.building);
const button = page.getByRole('button', { name: 'Собрать APK' });
check(await button.isDisabled(), 'пока собирается — кнопка закрыта');
const log = page.getByLabel('Вывод сборки');
const scroll = await log.evaluate((el) => ({
  bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
  overflow: el.scrollHeight > el.clientHeight,
}));
check(
  scroll.overflow && scroll.bottom,
  'вывод длиннее окна и прокручен вниз',
  JSON.stringify(scroll),
);
check(
  (await page.getByText('> Task :app:step40').count()) === 1,
  'последняя строка вывода на месте',
);
await shot('building');

// 3. Упала.
await open(STATES.failed);
check((await page.getByText('сборка упала').count()) === 1, 'упала: бейдж «сборка упала»');
check((await page.getByText('BUILD FAILED in 3m').count()) === 1, 'упала: причина в выводе видна');

// 4. Готово, телефон в adb.
await open(STATES.ready);
check(
  (await page.getByRole('button', { name: 'Обновить APK' }).count()) === 1,
  'файл есть: кнопка «Обновить APK»',
);
check((await page.getByText(/agentdeck\.apk — 159\.7 MB/).count()) === 1, 'размер файла назван');
await page.getByRole('button', { name: 'Поставить на emulator-5554' }).click();
await page.getByText('APK поставлен на emulator-5554').first().waitFor({ timeout: 5000 });
check(
  installBody?.device === 'emulator-5554',
  'установка уходит с серийным номером телефона',
  JSON.stringify(installBody),
);
const href = await page.getByText('Скачать APK').getAttribute('href');
check(href === '/api/mobile/apk/file', 'ссылка на скачивание ведёт на файл', href);
await shot('ready');

// 5. adb нет — кнопок установки нет, сказано почему.
await open(STATES.noAdb);
check(
  (await page.getByRole('button', { name: /Поставить на/ }).count()) === 0,
  'без adb кнопок установки нет',
);
check((await page.getByText(/adb не найден в PATH/).count()) === 1, 'без adb — сказано почему');

// 6. Второй запуск поверх идущего — отказ сервера виден человеку.
buildBusy = true;
await open(STATES.idle);
await page.getByRole('button', { name: 'Собрать APK' }).click();
await page.waitForTimeout(800);
check(
  (await page.getByText(/409|busy|Request failed/i).count()) > 0,
  'отказ сервера (409) показан, а не проглочен',
);
buildBusy = false;

// 7. Хук не стоит: команда целиком и путь к «Хукам».
await open(STATES.ready);
check((await page.getByText('хука нет', { exact: true }).count()) === 1, 'хука нет — бейдж');
check((await page.getByText(COMMAND).count()) === 1, 'команда хука показана целиком');
check(
  (await page.getByRole('button', { name: 'Открыть «Хуки»' }).count()) === 1,
  'есть путь в раздел «Хуки»',
);
await shot('relay-missing');

// 8. Переключатель шлёт PATCH.
await page.getByRole('switch', { name: /Присылать запросы на телефон/ }).click();
await page.waitForTimeout(600);
check(
  relayPatch?.enabled === false,
  'переключатель шлёт PATCH enabled:false',
  JSON.stringify(relayPatch),
);

// 8b. Выключено — панель хуки сняла, это не поломка: ни бейджа «хука нет», ни команды.
relay = { enabled: false, installed: false, shortTimeout: false, command: COMMAND };
await open(STATES.ready);
check(
  (await page.getByText('хука нет', { exact: true }).count()) === 0,
  'выключено — бейджа «хука нет» нет',
);
check((await page.getByText(COMMAND).count()) === 0, 'выключено — команды нет');

// 9. Хук стоит — команды нет.
relay = { enabled: true, installed: true, shortTimeout: false, command: COMMAND };
await open(STATES.ready);
check((await page.getByText('хук стоит', { exact: true }).count()) === 1, 'хук стоит — бейдж');
check((await page.getByText(COMMAND).count()) === 0, 'при стоящем хуке команды нет');

// 10. Хук стоит с таймаутом по умолчанию (60 с) — предупреждение, не «хук стоит».
relay = { enabled: true, installed: true, shortTimeout: true, command: COMMAND };
await open(STATES.ready);
check(
  (await page.getByText(/таймаут короче 10 минут/).count()) === 1,
  'короткий таймаут хука — предупреждение',
);
check(
  (await page.getByText('короткий таймаут', { exact: true }).count()) === 1,
  'бейдж «короткий таймаут», а не «хука нет»',
);
check(
  (await page.getByText('хук стоит', { exact: true }).count()) === 0,
  'с коротким таймаутом нет зелёного «хук стоит»',
);

check(problems.length === 0, 'ошибок на странице нет', problems[0] ?? '');
console.table(rows);
console.log(bad === 0 ? `OK: ${rows.length} из ${rows.length}` : `Проблем: ${bad}`);
await browser.close();
process.exitCode = bad === 0 ? 0 : 1;
