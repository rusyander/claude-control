/**
 * Сценарии раздела «Настройки»: `settings/first-run` и `settings/safety`.
 *
 * Делятся по входу. В первый приходят с только что открытой панелью и вопросом
 * «она вообще смотрит в тот каталог?»; во второй — когда всё уже работает и
 * вопрос другой: «что она делает с моими файлами перед записью и что от этого
 * остаётся».
 *
 * Мастер первого запуска показывается настоящий: `onboardingDone` гасится той
 * же ручкой настроек, которой пользуется интерфейс, и панель честно проходит
 * четыре шага. Найденные CLI на третьем шаге — те, что действительно стоят на
 * машине съёмки.
 */
import {
  openSection,
  openSettingsTab,
  patchSettings,
  card,
  closeModal,
  shotCard,
} from './access-providers-fixture.mjs';

/** Карточка мастера — это диалог; кадр берётся по нему, а не по окну целиком. */
const DIALOG = '[role="dialog"]';

export async function shootFirstRun(browser, web, scenario, { panel }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    // Мастер показывается, пока `onboardingDone` не выставлен. Гасим его тем
    // же запросом, которым панель его ставит, — состояние сервер прочитал с
    // диска на старте, и правка файла мимо API уже ничего не изменила бы.
    await patchSettings(panel, { onboardingDone: false });

    // ── 01. Первый экран ─────────────────────────────────────────────────────
    await openSection(page, web, '/', 2500);
    await scenario.shot(page, '01-wizard-intro', { clip: DIALOG, padding: 24 });

    // ── 02. Куда панель смотрит ──────────────────────────────────────────────
    // Каталог конфигурации — единственный шаг, который нельзя пропустить: без
    // него разделам нечего показывать.
    await page
      .getByRole('button', { name: /^(Далее|Next)$/ })
      .first()
      .click();
    await page.waitForTimeout(1800);
    await scenario.shot(page, '02-wizard-location', { clip: DIALOG, padding: 24 });

    // ── 03. Что нашлось в системе ────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Далее|Next)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '03-wizard-providers', { clip: DIALOG, padding: 24 });

    // ── 04. Откуда берётся доступ ────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Далее|Next)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-wizard-access', { clip: DIALOG, padding: 24 });

    // Закрываем мастер его же кнопкой: она и ставит `onboardingDone`.
    await page
      .getByRole('button', { name: /^(Готово|Done)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);

    // ── 05. Восемь вкладок ───────────────────────────────────────────────────
    // Кадр на всю страницу: главное здесь — полоса разделов, а не содержимое
    // первой вкладки.
    await openSettingsTab(page, web, 'general');
    await scenario.shot(page, '05-tabs');

    // ── 06. Каталог конфигурации ─────────────────────────────────────────────
    await openSettingsTab(page, web, 'access', 2500);
    await shotCard(scenario, page, '06-access-dir', card('Каталог .claude'));

    // ── 07. Откуда берётся доступ к аккаунту ─────────────────────────────────
    await shotCard(scenario, page, '07-access-credentials', card('Доступ Claude Code'));

    // ── 08. Доступ снаружи ───────────────────────────────────────────────────
    // Карточка снимается ВЫКЛЮЧЕННОЙ и без кода спаривания: код — это токен на
    // всё API панели, и показывать его в справке нельзя даже выдуманный.
    //
    // Адрес подменяется выдуманным ПЕРЕД кадром, и это не украшательство. Поле
    // показывает то, что панель нашла у живого `tailscale serve`, то есть имя
    // машины съёмки; замазывание по тексту сюда не достаёт — значение поля ввода
    // не текстовый узел, и по той же причине его не видит проверка каталога
    // снимков. Единственная защита здесь — не дать настоящему адресу попасть в
    // кадр вовсе.
    const remote = card('Удалённый доступ');
    await page
      .locator(remote)
      .getByLabel(/^(Адрес снаружи|Outside address)$/)
      .first()
      .fill('https://demo-stand.tailnet-example.ts.net');
    await page.waitForTimeout(600);
    await shotCard(scenario, page, '08-remote', remote);
  } finally {
    await page.close();
  }
}

export async function shootSafety(browser, web, scenario, { panel }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  try {
    await patchSettings(panel, { onboardingDone: true, backupBeforeWrite: true, backupKeep: 10 });
    // Копии берутся из настоящих записей: панель трижды пишет переменную в
    // settings.json, и каждая запись отправляет предыдущий файл в резервные
    // копии. Нарисовать эту карточку было бы нечестно — она про то, что панель
    // уже сделала с файлом.
    await writeEnv(panel, 'BASH_DEFAULT_TIMEOUT_MS', '120000');
    await writeEnv(panel, 'DISABLE_TELEMETRY', '1');
    await writeEnv(panel, 'MAX_THINKING_TOKENS', '31999');

    // ── 01. Что панель делает перед записью ──────────────────────────────────
    await openSettingsTab(page, web, 'safety', 2500);
    await shotCard(scenario, page, '01-safety', card('Безопасность правок'));

    // ── 02. Что осталось после ───────────────────────────────────────────────
    await shotCard(scenario, page, '02-backups', card('Резервные копии'));

    // ── 03. Парольная фраза для копий секретов ───────────────────────────────
    // Диалог открывает сам тумблер: фраза нигде не хранится, поэтому включить
    // шифрование, не задав её, нельзя — включение и есть этот вопрос.
    await page
      .getByLabel(/^(Шифровать копии секретов|Encrypt secret backups)$/)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '03-encrypt', { clip: DIALOG, padding: 24 });
    await closeModal(page);

    // ── 04. В чём считать расход ─────────────────────────────────────────────
    await openSettingsTab(page, web, 'spend', 2500);
    await shotCard(scenario, page, '04-spend', card('Расход'));

    // ── 05. Снимок настроек самой панели ─────────────────────────────────────
    await openSettingsTab(page, web, 'transfer', 2500);
    await shotCard(scenario, page, '05-transfer', card('Перенос настроек панели'));

    // ── 06. Что уедет вместе с конфигурацией провайдера ──────────────────────
    // Предпросмотр считается по-настоящему: панель перечисляет файлы, которые
    // попадут в архив, и отдельно — то, что придётся ввести руками.
    await page
      .getByRole('button', { name: /^(Экспорт|Export)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '06-env-transfer', { clip: DIALOG, padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

/**
 * Запись переменной — настоящая, она же и создаёт резервную копию файла.
 *
 * Маршрут именно `/api/env`, а не универсальный `/api/provider-env`: последний
 * обслуживает ЧУЖИЕ CLI и на активном Claude Code отвечает `section_unsupported`
 * — у него своя ветка маршрутов.
 */
async function writeEnv(panel, key, value) {
  const response = await fetch(`${panel}/api/env`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value, source: 'settings' }),
  });
  if (!response.ok) {
    throw new Error(`POST /api/env ${key}: ${response.status} ${await response.text()}`);
  }
}
