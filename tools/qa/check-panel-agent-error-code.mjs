/**
 * Ошибка хода агента панели — на языке интерфейса, а не строкой сервера одного языка; слова
 * модели и CLI — как есть. Кейс panel-agent-015.
 *
 * Ход идёт через ядро (этап 10): НАСТОЯЩИЙ `claude` сессией ядра «ask», модель — заглушка
 * (`panel-agent-core-stand.mjs`). Свои строки сервера у хода — «лишний инструмент», «не
 * ответил», «время вышло», «остановлен»: кадр `error` несёт `messageCode`, и окно переводит по
 * нему, а имя инструмента из CLI едет параметром как есть. Отказ модели CLI пересказывает своими
 * словами — они кода не получают и обязаны дойти до окна дословно.
 *
 * Путь человека в настоящем фронте:
 *   1. окно на английском, просьба «extra» → модель зовёт `Bash`, которого у агента нет → в ленте
 *      английская строка «лишнего инструмента» с `Bash`, русских букв нет;
 *   2. просьба «fail» → модель отказывает (HTTP 400 с нашей меткой) → в ленте слова отказа с
 *      этой меткой, без перевода;
 *   3. то же окно на русском, «extra» → русская строка того же кода.
 *
 * Нет `claude` в PATH — «не проверено» (код 2).
 * Запуск: `node tools/qa/check-panel-agent-error-code.mjs`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { runPanelAgentOnCore } from './panel-agent-core-stand.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'panel-agent-error-code');
mkdirSync(SHOTS, { recursive: true });

/** Метка отказа модели: CLI обязан донести её до окна как есть. */
const MODEL_WORDS = 'qa-model: request refused by the stub';
const EXTRA_EN =
  'The CLI gave the agent a tool beyond the panel bridge (Bash) — the turn was stopped so that the agent has no extra hands.';
const EXTRA_RU =
  'CLI дал агенту инструмент сверх переходника панели (Bash) — ход остановлен, чтобы у агента не было лишних рук.';

async function program({ current }) {
  if (/fail/i.test(current))
    return { error: { status: 400, message: MODEL_WORDS, type: 'invalid_request_error' } };
  return { tool: { name: 'Bash', args: { command: 'echo extra' } } };
}

async function ask(page, text) {
  const input = page.locator('[data-panel-agent-window] textarea');
  await input.waitFor({ timeout: 20_000 });
  const before = await page.locator('[data-agent-notice="error"]').count();
  await input.fill(text);
  await input.press('Enter');
  const last = page.locator('[data-agent-notice="error"]').nth(before);
  try {
    await last.waitFor({ timeout: 120_000 });
  } catch (error) {
    // Кадр того, что окно показало вместо ошибки, — рядом с кадрами проверки.
    await page.screenshot({ path: join(SHOTS, `no-error-${text}.png`) }).catch(() => {});
    throw error;
  }
  return (await last.textContent()) ?? '';
}

async function openWindow(browser, stand, language) {
  const page = await stand.newPage(browser);
  await bypassOnboarding(page, { language, theme: 'light' });
  await page.goto(`${stand.webUrl}/rules`);
  // Первый заход стенда с ядром — холодная сборка Vite под нагрузкой ядра: ждём кнопку дольше
  // таймаута клика по умолчанию.
  const trigger = page.locator('[data-panel-agent-trigger]').first();
  await trigger.waitFor({ timeout: 90_000 });
  await trigger.click();
  return page;
}

await runPanelAgentOnCore({ label: 'agent-error-code', program }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const en = await openWindow(browser, stand, 'en');
    const english = await ask(en, 'extra');
    check(
      'en: лишний инструмент — английской строкой с именем из CLI',
      english.trim() === EXTRA_EN,
      english,
    );
    check('en: русской строки сервера нет', !/[А-Яа-яЁё]/.test(english), english);
    await en.screenshot({ path: join(SHOTS, 'error-en_AFTER.png') });

    const refused = await ask(en, 'fail');
    check('отказ модели — её слова дословно', refused.includes(MODEL_WORDS), refused);
    check('страница en без ошибок', en.errors.length === 0, en.errors.join(' | '));

    const ru = await openWindow(browser, stand, 'ru');
    const russian = await ask(ru, 'extra');
    check('ru: тот же код — русской строкой', russian.trim() === EXTRA_RU, russian);
    await ru.screenshot({ path: join(SHOTS, 'error-ru_AFTER.png') });
    check('страница ru без ошибок', ru.errors.length === 0, ru.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
