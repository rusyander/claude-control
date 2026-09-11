/**
 * Кадры путеводителя «Контур», сторона ПЛАТФОРМА КОМПАНИИ: админка инстанса.
 *
 * Снимает живые экраны стенда — рисованных и «похожих» кадров в справке нет.
 * Ключи в кадре закрываются набором `kit.mjs` ДО снимка, и проверка
 * `tools/qa/check-help-shots.mjs` ищет их в описи того же кадра.
 *
 * Нужен поднятый стенд платформа компании и учётка админа инстанса. Вход — РОВНО ОДИН:
 * неудача останавливает съёмку, повторов нет (блокировка учётки дороже кадра).
 *
 * Запуск: node tools/help-shots/platform-connect-enterprise-platform.mjs
 * Переменные: ENTERPRISE_PLATFORM_ADMIN_URL (по умолчанию http://inst.localhost),
 *             ENTERPRISE_PLATFORM_ADMIN_LOGIN, ENTERPRISE_PLATFORM_ADMIN_PASSWORD_FILE.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openScenario } from './kit.mjs';

const BASE = process.env.ENTERPRISE_PLATFORM_ADMIN_URL ?? 'http://inst.localhost';
const LOGIN = process.env.ENTERPRISE_PLATFORM_ADMIN_LOGIN ?? 'admin@instance.local';
const PASSWORD_FILE =
  process.env.ENTERPRISE_PLATFORM_ADMIN_PASSWORD_FILE ??
  'c:/work/enterprise-platform-for-agentdeck/.dev/inst_admin_password.txt';

/** Имя ключа, который выпускается ради кадра и достаётся панели. */
const KEY_NAME = 'AgentDeck · путеводитель';

/**
 * Колонка ключа в списке: одна она известна по МЕСТУ, а не по виду — там стоит
 * обрезанный ключ («sk-» плюс десяток символов и многоточие), и под общее
 * выражение для целого ключа он не подходит.
 */
const KEY_CELL = 'td:nth-child(2) span, td:nth-child(2) code, td:nth-child(2) div';

const scenario = openScenario('platform', 'connect');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

try {
  // ── 1. Вход ──────────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await scenario.shot(page, '01-admin-login', { side: 'enterprise-platform' });

  const password = readFileSync(PASSWORD_FILE, 'utf8').trim();
  await page.fill('input[name="email"]', LOGIN);
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForTimeout(4000);
  if (page.url().includes('/login')) {
    throw new Error('вход не удался — останавливаюсь, повтора не будет');
  }

  // ── 2. Куда попадаешь ────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await scenario.shot(page, '02-admin-dashboard', { side: 'enterprise-platform' });

  // ── 3. Каталог моделей ───────────────────────────────────────────────────
  await page.goto(`${BASE}/models`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await scenario.shot(page, '03-admin-models', { side: 'enterprise-platform' });

  // ── 4. Форма модели: заполнена, но НЕ сохраняется ────────────────────────
  // Заполняется и провайдер, и адрес: справка объясняет на этом шаге, почему у
  // локальной модели адрес идёт БЕЗ `/v1`, и кадр с пустым полем и провайдером
  // по умолчанию спорил бы с собственным текстом.
  await page.goto(`${BASE}/models/create`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('input[name="name"]', 'Qwen 2.5 0.5B (локальная)');
  const provider = page.locator('select[name="provider"]');
  if (await provider.count()) await provider.selectOption({ label: 'Ollama' }).catch(() => {});
  await page.fill('input[name="model_ref"]', 'qwen2.5:0.5b');
  const apiBase = page.locator('input[name="api_base"]');
  if (await apiBase.count()) await apiBase.fill('http://host.docker.internal:11434');
  await page.fill('input[name="max_context_length"]', '32768');
  await page.waitForTimeout(400);
  await scenario.shot(page, '04-admin-model-create', { side: 'enterprise-platform' });

  // ── 5. Список ключей: колонка ключа закрывается ──────────────────────────
  await page.goto(`${BASE}/keys`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await scenario.shot(page, '05-admin-keys', { side: 'enterprise-platform', mask: [KEY_CELL] });

  // ── 6. Форма выпуска ключа ───────────────────────────────────────────────
  // Форма ключа — отдельная страница, как и форма модели: окна здесь нет.
  await page.goto(`${BASE}/keys/create`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('input[name="name"]', KEY_NAME);
  await page.fill('input[name="budget"]', '10');
  await page.fill('input[name="rpm_limit"]', '60');
  await page.fill('input[name="tpm_limit"]', '100000');
  await scenario.shot(page, '06-admin-key-create', { side: 'enterprise-platform' });

  // ── 7. Ключ показан один раз ─────────────────────────────────────────────
  await page
    .getByRole('button', { name: /^(Создать|Сохранить|Выпустить)/ })
    .last()
    .click();
  await page.waitForTimeout(3500);
  await scenario.shot(page, '07-admin-key-issued', { side: 'enterprise-platform' });

  // ── Уборка: снятый ключ на стенде не нужен ───────────────────────────────
  // Он выпущен ради одного кадра и в кадре закрыт, то есть нигде не сохранён.
  // Оставить его — значит копить мёртвые ключи с каждой пересъёмкой.
  await page.goto(`${BASE}/keys`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  let removed = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = page.locator('tr').filter({ hasText: KEY_NAME }).first();
    if ((await row.count()) === 0) break;
    await row.locator('button').last().click();
    await page.waitForTimeout(800);
    await page.getByText('Удалить', { exact: true }).first().click();
    await page.waitForTimeout(1000);
    const confirm = page.getByRole('button', { name: /^Удалить/ }).last();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(1800);
    removed += 1;
  }
  console.log(`  снятых ключей удалено: ${removed}`);

  // ── 8. Где смотреть расход ───────────────────────────────────────────────
  await page.goto(`${BASE}/usage`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await scenario.shot(page, '08-admin-usage', { side: 'enterprise-platform' });

  scenario.finish();
} finally {
  await browser.close();
}
