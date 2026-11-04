/**
 * Кадры путеводителя «Контур», сторона платформы компании: админка инстанса.
 *
 * Снимает живые экраны стенда — рисованных и «похожих» кадров в справке нет.
 * Ключи в кадре закрываются набором `kit.mjs` ДО снимка, и проверка
 * `tools/qa/check-help-shots.mjs` ищет их в описи того же кадра.
 *
 * Нужен поднятый стенд платформы компании и учётка админа инстанса. Вход — РОВНО ОДИН:
 * неудача останавливает съёмку, повторов нет (блокировка учётки дороже кадра).
 *
 * Запуск: node tools/help-shots/platform-connect-admin.mjs
 * Переменные: PLATFORM_ADMIN_URL (по умолчанию http://inst.localhost),
 *             PLATFORM_ADMIN_LOGIN, PLATFORM_ADMIN_PASSWORD_FILE — файл с одним паролем или
 *             файл dotenv: тогда PLATFORM_ADMIN_PASSWORD_VAR (и PLATFORM_ADMIN_LOGIN_VAR) —
 *             имена строк в нём. Ни пароль, ни логин из файла не печатаются.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openScenario, shotLanguage } from './kit.mjs';

const BASE = process.env.PLATFORM_ADMIN_URL ?? 'http://inst.localhost';
// Пароль — только файлом из переменной: где лежит учётка стенда, репозиторий не знает.
const PASSWORD_FILE = process.env.PLATFORM_ADMIN_PASSWORD_FILE;
if (!PASSWORD_FILE)
  throw new Error('нужна PLATFORM_ADMIN_PASSWORD_FILE: файл с паролем админа стенда');

/** Строка `ИМЯ=значение` файла dotenv; имени нет — `undefined` (без значения в тексте ошибки). */
function dotenvValue(text, name) {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '');
  return text.match(new RegExp(`^${safe}=(.*)$`, 'm'))?.[1]?.trim() || undefined;
}

function credentials() {
  const text = readFileSync(PASSWORD_FILE, 'utf8');
  const passwordVar = process.env.PLATFORM_ADMIN_PASSWORD_VAR;
  const loginVar = process.env.PLATFORM_ADMIN_LOGIN_VAR;
  const password = passwordVar ? dotenvValue(text, passwordVar) : text.trim();
  if (!password) throw new Error(`в файле пароля нет строки ${passwordVar ?? '(пароль)'}`);
  const login =
    (loginVar && dotenvValue(text, loginVar)) ||
    process.env.PLATFORM_ADMIN_LOGIN ||
    'admin@instance.local';
  return { login, password };
}

const EN = shotLanguage() === 'en';

/** Имя ключа, который выпускается ради кадра и достаётся панели. */
const KEY_NAME = EN ? 'AgentDeck · guide' : 'AgentDeck · путеводитель';

/**
 * Колонка ключа в списке: одна она известна по МЕСТУ, а не по виду — там стоит
 * обрезанный ключ («sk-» плюс десяток символов и многоточие), и под общее
 * выражение для целого ключа он не подходит.
 */
const KEY_CELL = 'td:nth-child(2) span, td:nth-child(2) code, td:nth-child(2) div';

const scenario = openScenario('platform', 'connect');

/**
 * Имя вошедшего в боковой панели админки — личные данные человека, а справка публичная: имя
 * (строка над адресом входа) и буква аватара заменяются нейтральными ДО снимка. Имя читается из
 * разметки и нигде не печатается; адрес входа закрывает общий список выражений набора.
 */
async function anonymizeUser(page, login) {
  await page.evaluate(
    ([email, neutral]) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let name = '';
      let row = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if ((node.textContent ?? '').trim() !== email) continue;
        const block = node.parentElement?.parentElement?.parentElement;
        const first = block?.firstElementChild;
        if (block && first && !first.contains(node)) {
          name = (first.textContent ?? '').trim();
          row = block.parentElement;
        }
        break;
      }
      if (!name) return;
      const swap = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const initial = name[0];
      while (swap.nextNode()) {
        const node = swap.currentNode;
        const text = node.textContent ?? '';
        if (text.includes(name)) node.textContent = text.replaceAll(name, neutral);
        else if (row?.contains(node) && text.trim() === initial) node.textContent = neutral[0];
      }
    },
    [login, EN ? 'Administrator' : 'Администратор'],
  );
}

const browser = await chromium.launch();
// Язык админки идёт от языка браузера: английские кадры — английским браузером.
const page = await browser.newPage({
  viewport: { width: 1280, height: 820 },
  locale: EN ? 'en-US' : 'ru-RU',
});

try {
  // ── 1. Вход ──────────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await scenario.shot(page, '01-admin-login', { side: 'platform' });

  const { login, password } = credentials();
  await page.fill('input[name="email"]', login);
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: /^(Войти|Sign in)$/ }).click();
  await page.waitForTimeout(4000);
  if (page.url().includes('/login')) {
    throw new Error('вход не удался — останавливаюсь, повтора не будет');
  }
  // После входа в боковой панели стоит имя человека: каждый кадр снимается после замены.
  const shoot = async (id, options) => {
    await anonymizeUser(page, login);
    await scenario.shot(page, id, options);
  };

  // ── 2. Куда попадаешь ────────────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await shoot('02-admin-dashboard', { side: 'platform' });

  // ── 3. Каталог моделей ───────────────────────────────────────────────────
  await page.goto(`${BASE}/models`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await shoot('03-admin-models', { side: 'platform' });

  // ── 4. Форма модели: заполнена, но НЕ сохраняется ────────────────────────
  // Заполняется и провайдер, и адрес: справка объясняет на этом шаге, почему у
  // локальной модели адрес идёт БЕЗ `/v1`, и кадр с пустым полем и провайдером
  // по умолчанию спорил бы с собственным текстом.
  await page.goto(`${BASE}/models/create`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('input[name="name"]', EN ? 'Qwen 2.5 0.5B (local)' : 'Qwen 2.5 0.5B (локальная)');
  const provider = page.locator('select[name="provider"]');
  if (await provider.count()) await provider.selectOption({ label: 'Ollama' }).catch(() => {});
  await page.fill('input[name="model_ref"]', 'qwen2.5:0.5b');
  const apiBase = page.locator('input[name="api_base"]');
  if (await apiBase.count()) await apiBase.fill('http://host.docker.internal:11434');
  await page.fill('input[name="max_context_length"]', '32768');
  await page.waitForTimeout(400);
  await shoot('04-admin-model-create', { side: 'platform' });

  // ── 5. Список ключей: колонка ключа закрывается ──────────────────────────
  await page.goto(`${BASE}/keys`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await shoot('05-admin-keys', { side: 'platform', mask: [KEY_CELL] });

  // ── 6. Форма выпуска ключа ───────────────────────────────────────────────
  // Форма ключа — отдельная страница, как и форма модели: окна здесь нет.
  await page.goto(`${BASE}/keys/create`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('input[name="name"]', KEY_NAME);
  await page.fill('input[name="budget"]', '10');
  await page.fill('input[name="rpm_limit"]', '60');
  await page.fill('input[name="tpm_limit"]', '100000');
  await shoot('06-admin-key-create', { side: 'platform' });

  // ── 7. Ключ показан один раз ─────────────────────────────────────────────
  await page
    .getByRole('button', { name: /^(Создать|Сохранить|Выпустить|Create|Save|Issue)/ })
    .last()
    .click();
  await page.waitForTimeout(3500);
  await shoot('07-admin-key-issued', { side: 'platform' });

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
    await page
      .getByText(/^(Удалить|Delete)$/)
      .first()
      .click();
    await page.waitForTimeout(1000);
    const confirm = page.getByRole('button', { name: /^(Удалить|Delete)/ }).last();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(1800);
    removed += 1;
  }
  console.log(`  снятых ключей удалено: ${removed}`);

  // ── 8. Где смотреть расход ───────────────────────────────────────────────
  await page.goto(`${BASE}/usage`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await shoot('08-admin-usage', { side: 'platform' });

  scenario.finish();
} finally {
  await browser.close();
}
