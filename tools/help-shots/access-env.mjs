/**
 * Сценарии раздела «Переменные окружения»: `env/secret` и `env/bulk`.
 *
 * Делятся по входу. В первый приходят с одним токеном в буфере обмена и
 * вопросом «куда его положить, чтобы он не попал в репозиторий»; во второй — с
 * готовым `.env` и вопросом «как перенести всё разом и почему одна переменная
 * не даёт себя править».
 *
 * Всё, что видно в кадре, панель посчитала сама: маска значения — её маска,
 * бейдж файла — файл, в который она записала, «группа: …» — настоящая группа,
 * применённая настоящим включением. Единственное, что съёмка делает мимо
 * интерфейса, — заводит эту группу запросом к API панели, как это делает телефон.
 */
import {
  closeModal,
  openSection,
  writeSecrets,
  writeSettings,
  writeSettingsLocal,
} from './access-fixture.mjs';

/** Обычная переменная, не секрет: с ней в разделе видна разница двух файлов. */
const PLAIN_ENV = { BASH_DEFAULT_TIMEOUT_MS: '120000' };

/** Строка списка переменных как область кадра: от имени переменной вверх. */
const row = (key) => `xpath=//span[normalize-space(text())="${key}"]/ancestor::div[3]`;

/** Завести включённую группу с переменными — тем же API, которым это делает телефон. */
async function makeGroup(panel, name, env) {
  const created = await fetch(`${panel}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, members: [] }),
  });
  const { id } = await created.json();
  await fetch(`${panel}/api/groups/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, members: [], env, isEnabled: true }),
  });
  return id;
}

export async function shootSecret(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

  try {
    // Одна обычная переменная уже есть — именно с этого места и виден вопрос:
    // токен рядом с ней класть нельзя, settings.json уезжает в репозиторий.
    writeSettings({ env: PLAIN_ENV });
    writeSettingsLocal(undefined);
    writeSecrets(undefined);

    // ── 01. Что здесь уже лежит ──────────────────────────────────────────────
    await openSection(page, web, '/env');
    await scenario.shot(page, '01-list-plain');

    // ── 02. Куда ляжет токен ─────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить переменную|Add variable)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.getByLabel(/^(Имя переменной|Variable name)$/).fill('WAREHOUSE_TOKEN');
    await page.getByLabel(/^(Значение|Value)$/).fill('whk_3f8a21d05c6b4e97a1d2');
    await page
      .getByLabel(/^(Комментарий|Comment)$/)
      .fill('Личный кабинет склада → Доступы → Создать токен');
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-form', { clip: '[role="dialog"]', padding: 24 });
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);

    // ── 03. Секрет в списке ──────────────────────────────────────────────────
    await scenario.shot(page, '03-list-masked');

    // ── 04. Показать значение ────────────────────────────────────────────────
    // Полное значение приходит отдельным запросом и только по этой кнопке:
    // в общем ответе `/api/env` его нет вовсе.
    await page
      .locator(row('WAREHOUSE_TOKEN'))
      .getByLabel(/^(Показать значение|Reveal value)$/)
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '04-revealed', { clip: row('WAREHOUSE_TOKEN'), padding: 20 });

    // ── 05. Правка секрета ───────────────────────────────────────────────────
    await page
      .locator(row('WAREHOUSE_TOKEN'))
      .getByLabel(/^(Редактировать|Edit): /)
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '05-secret-edit', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootBulk(browser, web, scenario, { panel }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

  try {
    writeSettings({ env: PLAIN_ENV });
    writeSettingsLocal(undefined);
    writeSecrets(undefined);

    // ── 01. Целый .env разом ─────────────────────────────────────────────────
    // Файл выбирается по ИМЕНИ переменной: слово TOKEN, SECRET, KEY, PASSWORD
    // или CREDENTIALS целиком — в файл секретов, остальное — в settings.json.
    await openSection(page, web, '/env');
    await page
      .getByRole('button', { name: /^(Добавить переменную|Add variable)$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page
      .getByRole('button', { name: /^(Несколько сразу|Several at once)$/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await page
      .locator('[role="dialog"] textarea')
      .first()
      .fill(
        [
          'WAREHOUSE_TOKEN=whk_3f8a21d05c6b4e97a1d2',
          'DELIVERY_API_KEY=dl_77b1c4e0aa93',
          'ORDERS_API_URL=http://127.0.0.1:8080',
          'BASH_MAX_TIMEOUT_MS=600000',
          'DISABLE_TELEMETRY=1',
        ].join('\n'),
      );
    await page.waitForTimeout(900);
    await scenario.shot(page, '01-bulk', { clip: '[role="dialog"]', padding: 24 });
    await page
      .getByRole('button', { name: /^(Создать все|Create all)/ })
      .first()
      .click();
    await page.waitForTimeout(3000);
    await closeModal(page);

    // ── 02. Два файла в одном списке ─────────────────────────────────────────
    await openSection(page, web, '/env');
    await scenario.shot(page, '02-list-mixed');

    // ── 03. Перенос в личный файл ────────────────────────────────────────────
    // settings.local.json Claude Code читает наравне с общим, но в репозиторий
    // этот файл не уезжает — туда переносят то, что своё, а не командное.
    await page
      .locator(row('ORDERS_API_URL'))
      .getByLabel(/^(В локальные|To local)/)
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '03-local');

    // ── 04. Переменная, которой владеет группа ───────────────────────────────
    await makeGroup(panel, 'Проверка релиза', {
      TEST_MODE: 'record',
      PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:8080',
    });
    await openSection(page, web, '/env');
    // Кадр на всю страницу, а не по строке: главное здесь — чего у этой строки
    // НЕТ рядом с соседними, а обрезанная по строке область этого не показывает.
    await scenario.shot(page, '04-group');

    // ── 05. Что значит «удалить» ─────────────────────────────────────────────
    await page
      .locator(row('DELIVERY_API_KEY'))
      .getByLabel(/^(Удалить|Delete): /)
      .first()
      .click();
    await page.waitForTimeout(1000);
    await scenario.shot(page, '05-delete', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
