/**
 * Обмен раздела «Тесты» вживую: импорт результатов CI и выгрузка группы.
 *
 * Единственный прогон в наборе, который НИЧЕГО не подменяет: и сервер, и файлы
 * настоящие. Иначе проверять здесь было бы нечего — вся суть обмена в том, что
 * панель читает чужой файл с диска и переписывает кейсы проекта, а подменённый
 * ответ доказывает только отрисовку.
 *
 * Проект собирается во временном каталоге и остаётся после прогона: он же нужен
 * `.agent/tmp/verify-tests-live.mjs`. Внутри репозитория его держать нельзя —
 * наблюдатель `pnpm dev` перезапустит сервер на каждой записи.
 *
 * Запуск: `node tools/qa/check-tests-exchange.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const ROOT = join(tmpdir(), 'claude-qa-live-project');
const GROUP = 'gui';

if (!existsSync(join(ROOT, '.agent/tests', `${GROUP}.tests.json`))) {
  console.log(`Нет проекта ${ROOT} — сначала node .agent/tmp/verify-tests-live.mjs`);
  process.exit(1);
}

// Отчёт CI кладём в сам проект: путь внутри проекта — основной способ, файл с
// диска через диалог второй.
const REPORT = join(ROOT, 'test-results');
mkdirSync(REPORT, { recursive: true });
writeFileSync(
  join(REPORT, 'junit.xml'),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    '  <testsuite name="gui">',
    '    <testcase name="вход работает" time="1.5"/>',
    '    <testcase name="ничей тест" time="0.2"><failure message="упал"/></testcase>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n'),
  'utf8',
);

// Ручные кейсы лежат в самом репозитории — их и кладём: у импорта markdown нет
// ни файла с диска, ни содержимого в теле, только каталог внутри проекта.
const MANUAL_ID = 'ТК-900';
mkdirSync(join(ROOT, 'QA', 'auth'), { recursive: true });
writeFileSync(
  join(ROOT, 'QA', 'auth', `${MANUAL_ID}.md`),
  [
    `# ${MANUAL_ID}. Вход по одноразовому коду`,
    '',
    '**Зона:** авторизация',
    '**Приоритет:** высокий',
    '',
    '## Предусловие',
    '',
    'Пользователь зарегистрирован',
    '',
    '## Шаги',
    '',
    '1. Открыть форму входа',
    '   - Ожидание: форма открыта',
    '',
    '## Ожидаемый результат',
    '',
    'Пользователь внутри',
    '',
  ].join('\n'),
  'utf8',
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (path) =>
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: path.toLowerCase(), path, name: 'QA живой проект' }],
        activeTabId: path.toLowerCase(),
        views: {},
      }),
    ),
  ROOT,
);

await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2500);

const main = page.getByRole('main').first();
check((await main.getByText('.agent/tests').count()) > 0, 'раздел открылся на живом проекте');

const exchange = main.getByRole('button', { name: 'Обмен' }).first();
check((await exchange.count()) > 0, 'над библиотекой есть кнопка обмена');
if ((await exchange.count()) === 0) {
  await browser.close();
  console.log(`\nПроблем: ${bad + 1}`);
  process.exit(1);
}

await exchange.click();
await page.waitForTimeout(600);
const modal = page.getByRole('dialog').first();
check((await modal.count()) > 0, 'окно обмена открылось');

// Путь ОТ КОРНЯ проекта: сервер сам находит файл, копировать содержимое не надо.
await modal.getByLabel('Файл в проекте').first().fill('test-results/junit.xml');
await modal.getByRole('button', { name: 'Взять из проекта' }).first().click();
await page.waitForTimeout(2500);

const badges = await modal.innerText();
check(
  /прочитано:\s*2/.test(badges),
  `прочитано два результата: ${/прочитано:\s*\d+/.exec(badges)}`,
);
check(/легло на кейсы:\s*1/.test(badges), 'один результат лёг на кейс по имени теста');
check(/не нашлось:\s*1/.test(badges), 'несопоставленное названо, а не проглочено');
check(badges.includes('ничей тест'), 'несопоставленный тест назван по имени');

// Ручные кейсы: формат без файла и без содержимого — сервер сам обходит каталог
// проекта. Номер из имени файла обязан стать номером кейса, иначе связь с тем,
// как этот кейс зовут в дефекте и в MR, теряется ровно там, где она нужнее.
const formatField = modal.getByLabel('Формат').nth(1);
await formatField.selectOption({ label: 'Ручные кейсы (ТК-*.md)' });
await page.waitForTimeout(400);
check(
  (await modal.getByLabel('Каталог в проекте').count()) > 0,
  'у ручных кейсов спрашивается каталог, а не файл',
);
await modal.getByRole('button', { name: 'Взять из проекта' }).nth(1).click();
await page.waitForTimeout(2500);

const manual = await modal.innerText();
check(
  /прочитано:\s*1/.test(manual),
  `прочитан один ручной кейс: ${/прочитано:\s*\d+/.exec(manual)}`,
);
// «Завёлся» ИЛИ «лёг на существующий»: живой проект переживает прогоны, и после
// первого раза кейс в нём уже есть. Главное проверяет второй импорт ниже —
// двойника появиться не должно.
check(
  /заведено:\s*1/.test(manual) || /легло на кейсы:\s*1/.test(manual),
  'ручной кейс лёг в группу',
);

// Повторный импорт того же файла обязан ЛЕЧЬ НА ТОТ ЖЕ кейс.
await modal.getByRole('button', { name: 'Взять из проекта' }).nth(1).click();
await page.waitForTimeout(2500);
const again = await modal.innerText();
check(/легло на кейсы:\s*1/.test(again), 'повторный импорт обновил кейс');
check(!/заведено:\s*1/.test(again), 'повторный импорт не завёл двойника');

// Выгрузка — обычная ссылка: браузер отдаёт файл с именем от сервера.
const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => undefined);
await modal.getByText('Скачать').first().click();
const file = await download;
check(Boolean(file), `выгрузка скачалась: ${file ? await file.suggestedFilename() : 'нет'}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(1200);

// Кейс виден в библиотеке без F5, а его номер — тот, что стоял в имени файла:
// в списке колонки идентификатора нет, он показан в карточке кейса.
const manualRow = main.getByText('Вход по одноразовому коду', { exact: false }).first();
check((await manualRow.count()) > 0, 'ручной кейс появился в библиотеке без перезагрузки');
if ((await manualRow.count()) > 0) {
  await manualRow.click();
  await page.waitForTimeout(1200);
  const card = page.getByRole('dialog').first();
  check(
    (await card.getByText(MANUAL_ID, { exact: false }).count()) > 0,
    `номер из имени файла сохранён: ${MANUAL_ID}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}

// Импорт обязан быть виден там же, где кейсы: статус пришёл из CI, и библиотека
// перечитывается сама, без F5.
const runsTab = main
  .getByRole('tab', { name: /Прогоны/ })
  .first()
  .or(main.getByRole('button', { name: /Прогоны/ }).first());
if ((await runsTab.count()) === 0) {
  check(false, 'у раздела есть вкладка истории прогонов');
} else {
  await runsTab.first().click();
  await page.waitForTimeout(2000);
  check((await main.getByText(/импорт/i).count()) > 0, 'импорт лёг записью прогона в историю');
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nОбмен в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
