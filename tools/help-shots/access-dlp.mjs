/**
 * Сценарии раздела «Защита данных»: `dlp/first` и `dlp/gate`.
 *
 * Делятся по входу, и это две разные задачи. В первый приходят с требованием
 * «персональные данные не должны уходить в модель» — там прокси, правила и
 * журнал. Во второй приходят с задачей поменьше: «пусть панель хотя бы
 * остановит меня, если я сам вставлю в промпт лишнее» — там гейт на промпте,
 * который видит принципиально меньше и говорит об этом прямо.
 *
 * Прокси в кадре работает по-настоящему: он поднят на петле, наверх у него
 * выдуманная модель, а журнал и счётчики заполняются живыми запросами, которые
 * съёмка делает тем же способом, что и CLI, — обычным POST на его адрес.
 *
 * Ни одно значение в кадре не настоящее: имя, телефон и номер карты выдуманы, а
 * номер карты взят из общеизвестного тестового диапазона (он проходит проверку
 * Луна — иначе правило его бы не нашло, и кадр показывал бы пустоту).
 */
import { openSection, card, patchSettings, shotCard } from './access-providers-fixture.mjs';

const STATUS = card('Прокси');
const GATE = card('Гейт на промпте');
const PREVIEW = card('Проверка на пробном тексте');
const JOURNAL = card('Журнал срабатываний');

/** Пробный текст: имя из словаря, телефон и номер карты из тестового диапазона. */
const SAMPLE = 'Сверь заказ Ивана Петрова, телефон +7 999 123-45-67, карта 4111 1111 1111 1111';

/** Профиль эндпоинта, в который смотрит прокси. Заводится, если его ещё нет. */
async function ensureProfile(panel, upstream) {
  const settings = await (await fetch(`${panel}/api/settings`)).json();
  if (settings.endpointProfiles?.length) return settings.endpointProfiles[0].id;
  const id = 'ep-guide-gateway';
  await patchSettings(panel, {
    endpointProfiles: [
      {
        id,
        name: 'Шлюз отдела',
        baseUrl: upstream,
        apiKind: 'anthropic',
        model: '',
        writeToken: false,
        ownerPlatformId: '',
      },
    ],
  });
  return id;
}

export async function shootDlpFirst(browser, web, scenario, { panel, upstream, dlpPort }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1500 } });

  try {
    await ensureProfile(panel, upstream);
    await stopProxy(panel);
    await clearRules(panel);
    await clearJournal(panel);

    // ── 01. Правил ещё нет ───────────────────────────────────────────────────
    // Пока не включено ни одно правило, прокси не запустится: пустой список
    // правил — это не «пропускать всё», а «нечего делать».
    await openSection(page, web, '/dlp', 2500);
    await scenario.shot(page, '01-empty');

    // ── 02. Готовый набор ────────────────────────────────────────────────────
    // У ИНН, СНИЛС и карты сверяется контрольная сумма — иначе правило ловило
    // бы любое число подходящей длины.
    await page
      .getByRole('button', { name: /^(Добавить готовый набор|Add the ready-made set)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '02-starter');

    // ── 03. Свой словарь ─────────────────────────────────────────────────────
    // Последним в наборе идёт пустой «Свой словарь» — его и заполняем: имена
    // сотрудников, названия проектов, адреса. Русские окончания учитываются.
    const terms = page.getByLabel(/^(Словарь|Dictionary)$/).last();
    await terms.fill(['Иван Петров', 'Проект «Ангара»', 'Северный склад'].join('\n'));
    await terms.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await scenario.shot(page, '03-terms');

    await page
      .getByRole('button', { name: /^(Сохранить правила|Save rules)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);

    // ── 04. Проверка на пробном тексте ───────────────────────────────────────
    // Показывает ровно то, что увидела бы модель, и никуда не ходит по сети.
    await page
      .locator(PREVIEW)
      .getByLabel(/^(Пробный текст|Sample text)$/)
      .first()
      .fill(SAMPLE);
    await page.waitForTimeout(600);
    await page
      .locator(PREVIEW)
      .getByRole('button', { name: /^(Проверить|Check)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '04-preview', PREVIEW);

    // ── 05. Прокси работает ──────────────────────────────────────────────────
    await page
      .locator(STATUS)
      .getByLabel(/^(Порт|Port)$/)
      .first()
      .fill(String(dlpPort));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page
      .locator(STATUS)
      .getByLabel(/^(Профиль эндпоинта|Endpoint profile)$/)
      .first()
      .selectOption({ label: 'Шлюз отдела' });
    await page.waitForTimeout(1500);
    await page
      .locator(STATUS)
      .getByRole('button', { name: /^(Запустить|Start)$/ })
      .first()
      .click();
    await page.waitForTimeout(3000);
    await shotCard(scenario, page, '05-running', STATUS);

    // ── 06. Журнал после живых запросов ──────────────────────────────────────
    // Два запроса тем же способом, каким ходит CLI: один с заменой, второй с
    // ключом — на встроенном образце «Секретные ключи» стоит «отклонить», и
    // запрос не уходит никуда.
    await sendThroughProxy(dlpPort, 'Сверь заказ Ивана Петрова, телефон +7 999 123-45-67');
    // Выдуманный ключ намеренно длинный: встроенный образец ищет `sk-` и не
    // меньше шестнадцати знаков после него — на более коротком правило не
    // срабатывает вовсе, и кадр показывал бы «пропущено» вместо отказа.
    await sendThroughProxy(dlpPort, `Ключ стенда ${['sk', 'demo', 'a41c7e9b20f3d8'].join('-')}`);
    await page.waitForTimeout(1500);
    await openSection(page, web, '/dlp', 2500);
    await shotCard(scenario, page, '06-journal', JOURNAL);

    // Счётчики на карточке — уже измерение, а не обещание.
    await shotCard(scenario, page, '07-counters', STATUS);

    await stopProxy(panel);
  } finally {
    await page.close();
  }
}

export async function shootDlpGate(browser, web, scenario, { panel }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } });

  try {
    await patchSettings(panel, {
      provider: 'claude',
      promptGate: { enabled: false, action: 'block' },
    });

    // ── 01. Что гейт видит, а чего не видит ──────────────────────────────────
    await openSection(page, web, '/dlp', 2500);
    await shotCard(scenario, page, '01-gate-off', GATE);

    // ── 02. Установлен ───────────────────────────────────────────────────────
    // Панель кладёт скрипт хука и регистрирует его; путь показан целиком —
    // по нему видно, что это файл в вашей же конфигурации, а не в панели.
    await page
      .locator(GATE)
      .getByLabel(/^(Гейт на промпте|Prompt gate)$/)
      .first()
      .click();
    await page.waitForTimeout(3500);
    await shotCard(scenario, page, '02-gate-on', GATE);

    // ── 03. Тот же хук в разделе «Хуки» ──────────────────────────────────────
    await openSection(page, web, '/hooks', 3000);
    await scenario.shot(page, '03-hook');

    // ── 04. Почему только Claude Code ────────────────────────────────────────
    // У остальных CLI событие «промпт отправлен» с возможностью отказа не
    // задокументировано, и панель говорит это прямо, а не гасит тумблер молча.
    await patchSettings(panel, { provider: 'codex' });
    await openSection(page, web, '/dlp', 3000);
    await shotCard(scenario, page, '04-claude-only', GATE);

    await patchSettings(panel, { provider: 'claude' });
  } finally {
    await page.close();
  }
}

/** Запрос через прокси — ровно тем же способом, каким в него ходит CLI. */
async function sendThroughProxy(port, text) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qa-standard',
        max_tokens: 64,
        messages: [{ role: 'user', content: text }],
      }),
    });
  } catch {
    /* отказ прокси — это тоже запись в журнале, ради неё и идём */
  }
}

async function stopProxy(panel) {
  await fetch(`${panel}/api/dlp/stop`, { method: 'POST' }).catch(() => undefined);
}

async function clearJournal(panel) {
  await fetch(`${panel}/api/dlp/journal`, { method: 'DELETE' }).catch(() => undefined);
}

/** Правил нет — ровно то состояние, с которого раздел открывают в первый раз. */
async function clearRules(panel) {
  const response = await fetch(`${panel}/api/dlp/rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: [] }),
  });
  if (!response.ok) throw new Error(`PUT /api/dlp/rules: ${response.status}`);
}
