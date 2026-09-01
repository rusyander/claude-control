/**
 * Сквозная проверка: создать группу через интерфейс, убедиться, что она
 * появилась в списке и что её метка проставилась выбранному скиллу, затем
 * удалить. Безопасно: группы хранятся в данных приложения и конфиги
 * Claude Code не затрагивают.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
// Без скобок и прочих спецсимволов: имя подставляется в регулярное выражение
// при поиске кнопки удаления.
const GROUP_NAME = 'Проверка записи QA';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.goto(`${BASE_URL}/groups`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

// --- привязка к проекту и порядок работы: только форма, без сохранения ---
// Сценарий НЕ сохраняем намеренно: сохранение записало бы скилл в настоящий
// ~/.claude/skills, а автотест не имеет права оставлять следы в конфигурации.
await page.getByRole('button', { name: /Создать группу/i }).click();
await page.waitForSelector('[role="dialog"]');

// Ищем внутри диалога: «Проекты» есть ещё и в боковом меню.
const dialog = page.locator('[role="dialog"]');
const hasBinding = await dialog.getByText('Проекты', { exact: true }).isVisible();
const hasOrder = await dialog.getByText('Порядок работы', { exact: true }).isVisible();
console.log('Блоки привязки и порядка работы на месте:', hasBinding && hasOrder ? 'да' : 'НЕТ');

await page.getByLabel('Триггер по тексту запроса').fill('GOR-(\\d+');
await page.waitForTimeout(200);
const showsTriggerError = await page.getByText('Это не регулярное выражение').isVisible();
console.log('Сломанное выражение триггера подсвечено:', showsTriggerError ? 'да' : 'НЕТ');

await page.getByRole('button', { name: /Добавить шаг/i }).click();
await page.waitForTimeout(200);
const hasStepFields = await page.getByLabel('Готово, когда').isVisible();
console.log('Шаг добавляется вместе с признаком выполнения:', hasStepFields ? 'да' : 'НЕТ');

await page.getByRole('button', { name: /^Отмена$/ }).click();
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });

// --- создание ---
await page.getByRole('button', { name: /Создать группу/i }).click();
await page.waitForSelector('[role="dialog"]');
await page.getByLabel('Название').fill(GROUP_NAME);
await page.getByLabel('Описание').fill('создана автотестом, будет удалена');

// Отмечаем первый скилл в списке участников.
await page.getByRole('button', { name: 'Скилл', exact: true }).click();
await page.locator('[role="dialog"] input[type="checkbox"]').first().check();

await page.getByRole('button', { name: /^Сохранить$/ }).click();
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });

// Ждём карточку, а не спим наугад: список обновляется запросом, и с ростом
// числа групп фиксированной паузы переставало хватать — проверка врала «НЕТ»
// на успешно созданной группе. `.first()` — на случай оставшейся от прошлого
// прогона тёзки: strict mode иначе роняет весь скрипт.
const card = page.getByText(GROUP_NAME).first();
const isCreated = await card
  .waitFor({ state: 'visible', timeout: 8000 })
  .then(() => true)
  .catch(() => false);
console.log('Группа создана и видна в списке:', isCreated ? 'да' : 'НЕТ');

// --- метка у скилла ---
await page.goto(`${BASE_URL}/skills`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(500);

// --- удаление ---
await page.goto(`${BASE_URL}/groups`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(500);
await page
  .getByRole('button', { name: new RegExp(`Удалить: ${GROUP_NAME}`, 'i') })
  .first()
  .click();

// Удаление — двухступенчатое: имя вводится дословно, иначе кнопка недоступна.
// Раньше прогон об этой ступени не знал: кликал по корзине, видел, что карточка
// «не видна» (её закрывал диалог), и рапортовал успех — а группа оставалась в
// состоянии панели и копилась там от прогона к прогону.
await page.getByPlaceholder(GROUP_NAME).fill(GROUP_NAME);
await page.getByRole('button', { name: /^Удалить$/ }).click();

// Пропажу карточки тоже ждём: «удалена» по одной паузе означало лишь «ещё не
// нарисовалась», и прогон рапортовал успех, оставляя группу в состоянии панели.
const isDeleted = await page
  .getByText(GROUP_NAME)
  .first()
  .waitFor({ state: 'detached', timeout: 8000 })
  .then(() => true)
  .catch(() => false);
console.log('Группа удалена:', isDeleted ? 'да' : 'НЕТ');

await browser.close();
console.log(problems.length ? `ПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : 'Ошибок консоли нет.');
