/**
 * Сценарии справки «Локальные модели».
 *
 *   localModels/first — раздел от первого входа до агентов на своей карте:
 *                       подбор под карту, загрузка с полосой, готовый сервер
 *                       с моделью в памяти, выбор набора. Подсказки под полем чата
 *                       больше нет (владелец 06.10) — она вверху раздела.
 *
 * Снимаются области (карточки — регионы с именем), а не окно целиком: на кадре
 * всей страницы строку каталога или полосу загрузки не прочитать.
 *
 * Раздел разложен по вкладкам (`?tab=hardware|models|agents`): каждый кадр
 * открывает свою вкладку адресом, иначе нужной карточки на странице просто нет.
 */
import { STATES, localModelsRoutes } from './local-models-stubs.mjs';
import { settings } from './chat-stubs.mjs';

const region = (ru, en) =>
  `[role="region"][aria-label="${ru}"], [role="region"][aria-label="${en}"]`;
const CATALOG = region('Модели для кода', 'Coding models');
const AGENTS = region('Агенты на локальной модели', 'Agents on the local model');

async function openTab(page, web, tab, selector = '[role="region"]') {
  await page.goto(`${web}/local-models?tab=${tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForSelector(selector);
  await page.waitForTimeout(1200);
}

/** Новое состояние — перезагрузкой: адрес, а с ним и вкладка, остаются прежними. */
async function switchTo(page, holder, name, selector = '[role="region"]') {
  holder.state = STATES[name];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selector);
  await page.waitForTimeout(1200);
}

export async function shootFirst(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  // Ошибка рендера иначе видна только как таймаут ожидания карточки.
  page.on('pageerror', (error) => console.log(`  ошибка страницы: ${error.message}`));
  const holder = { state: STATES.empty };
  try {
    await settings(page);
    await localModelsRoutes(page, holder);
    await openTab(page, web, 'hardware');

    // ── 01. Первый вход: карта, сервер не установлен (вкладка «Железо и сервер») ──
    await scenario.shot(page, '01-machine');

    // ── 02. Каталог крупно: «Рекомендуем», что влезет и почему не агент ──────
    await openTab(page, web, 'models', CATALOG);
    await scenario.shot(page, '02-catalog', { clip: CATALOG, padding: 12 });

    // ── 03. Загрузка: полоса, скорость, сколько осталось ────────────────────
    await switchTo(page, holder, 'pulling', CATALOG);
    await scenario.shot(page, '03-pulling', { clip: CATALOG, padding: 12 });

    // ── 04. Готово: сервер запущен, где считать, «В памяти» (вкладка «Железо и сервер») ──
    holder.state = STATES.ready;
    await openTab(page, web, 'hardware');
    await scenario.shot(page, '04-ready');

    // ── 05. Агенты и набор: облако одной кнопкой, чей набор у агента ────────
    await openTab(page, web, 'agents', AGENTS);
    // Снимок области вне окна пуст — карточку держим в окне.
    await page.locator(AGENTS).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '05-agents', { clip: AGENTS, padding: 12 });
  } finally {
    await page.close();
  }
}

const ROW = (tag) => `article:has-text("${tag}")`;
const TAG = 'qwen3.6:27b-coding';

/** Выбрать значение в n-м списке строки (0 — квантование, 1 — контекст) и дождаться пересчёта. */
async function pick(page, row, index, value) {
  await page.locator(row).first().locator('select').nth(index).selectOption(value);
  await page.waitForTimeout(900);
}

/**
 *   localModels/choice — два списка строки: квантование и контекст. Каждый кадр —
 *                        одна строка каталога, не вся страница: на целой странице
 *                        подписи вариантов не прочитать.
 *
 * Выбор уходит в заглушку (`PUT /choice`), она его помнит, и страница пересчитывает
 * списки сама, теми же функциями, что и сервер: кадр — ответ на настоящий клик.
 */
export async function shootChoice(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  page.on('pageerror', (error) => console.log(`  ошибка страницы: ${error.message}`));
  const holder = { state: STATES.ready };
  try {
    await settings(page);
    await localModelsRoutes(page, holder);
    await openTab(page, web, 'models', CATALOG);
    const row = ROW(TAG);
    await page.locator(row).first().scrollIntoViewIfNeeded();

    // ── 01. Строка как есть: выбор по умолчанию, замер снят при нём же ────────
    await scenario.shot(page, '01-selects', { clip: row, padding: 12 });

    // ── 02. Другое квантование: размер пересчитан, файла нет — кнопка скачать ──
    await pick(page, row, 0, 'UD-Q4_K_XL');
    await page.locator(row).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '02-other-quant', { clip: row, padding: 12 });

    // ── 03. Вернули скачанное, взяли окно больше: идущий сервер перезапускается ──
    holder.choices = {};
    holder.state = STATES.restarting;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(CATALOG);
    await page.waitForTimeout(1200);
    await page.locator(row).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '03-restart', { clip: row, padding: 12 });

    // ── 04. «Любая модель»: репозиторий введён, список квантований прочитан при добавлении ──
    holder.state = STATES.ready;
    holder.choices = {};
    await openTab(page, web, 'models', CATALOG);
    const form = 'form[aria-label="Любая модель"], form[aria-label="Any model"]';
    await page.locator(form).first().scrollIntoViewIfNeeded();
    await page.locator(form).first().locator('input').fill('unsloth/Qwen3-14B-GGUF');
    await scenario.shot(page, '04-custom-form', { clip: form, padding: 12 });

    // ── 05. Добавлена: бейджи «Своя» и «Агентность не проверена», те же два списка ──
    await page.locator(form).first().locator('button[type="submit"]').click();
    const custom = ROW('unsloth/Qwen3-14B-GGUF');
    await page.waitForSelector(custom);
    // Тост «Добавлено» не должен попасть в кадр строки.
    await page
      .getByText(/Добавлено|Added/)
      .first()
      .waitFor({ state: 'hidden', timeout: 20000 });
    await page.locator(custom).first().scrollIntoViewIfNeeded();
    await scenario.shot(page, '05-custom-row', { clip: custom, padding: 12 });
  } finally {
    await page.close();
  }
}
