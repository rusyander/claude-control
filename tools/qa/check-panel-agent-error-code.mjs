/**
 * Ошибка хода агента панели — на языке интерфейса, а не русской строкой сервера.
 *
 * До правки 09.10.2026 кадр `error` нёс только русский `message`: в окне на
 * английском человек читал «CLI завершился с кодом 3 без ответа.». Теперь
 * сервер кладёт рядом `messageCode` + `params`, если узнал свою строку, и окно
 * переводит по коду; слова самого CLI (stderr) кода не получают и едут как есть.
 *
 * Путь человека в настоящем фронте на своём одноразовом стенде; подменена только
 * модель — фальшивый `claude` первым в PATH:
 *   1. окно на английском, просьба «exit» → CLI молча выходит с кодом 3 → в
 *      ленте английская строка с кодом 3, русской нет;
 *   2. то же окно на русском → русская строка того же кода;
 *   3. просьба «stderr» → CLI пишет причину в stderr → строка CLI дословно.
 *
 * Запуск: `node tools/qa/check-panel-agent-error-code.mjs`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'panel-agent-error-code');
mkdirSync(SHOTS, { recursive: true });

const CLI_WORDS = 'qa-cli: model endpoint refused';

// Фальшивый `claude`: читает промпт из stdin и выходит без ответа — молча с кодом 3
// либо со своей причиной в stderr, если в текущей просьбе есть «stderr».
const FAKE_CLI = String.raw`
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  if (input.includes('stderr')) {
    process.stderr.write(${JSON.stringify(CLI_WORDS)});
    process.exit(1);
  }
  process.exit(3);
});
`;

async function ask(page, text) {
  const input = page.locator('[data-panel-agent-window] textarea');
  await input.waitFor({ timeout: 20_000 });
  const before = await page.locator('[data-agent-notice="error"]').count();
  await input.fill(text);
  await input.press('Enter');
  const last = page.locator('[data-agent-notice="error"]').nth(before);
  await last.waitFor({ timeout: 30_000 });
  return (await last.textContent()) ?? '';
}

async function openWindow(browser, stand, language) {
  const page = await stand.newPage(browser);
  await bypassOnboarding(page, { language, theme: 'light' });
  await page.goto(`${stand.webUrl}/rules`);
  await page.locator('[data-panel-agent-trigger]').first().click();
  return page;
}

await runOnStand(
  { label: 'agent-error-code', fakeCli: { claude: FAKE_CLI } },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const en = await openWindow(browser, stand, 'en');
      const english = await ask(en, 'exit');
      check(
        'en: код выхода CLI — английской строкой',
        english.trim() === 'The CLI exited with code 3 without an answer.',
        english,
      );
      check('en: русской строки сервера нет', !/[А-Яа-яЁё]/.test(english), english);
      await en.screenshot({ path: join(SHOTS, 'error-en_AFTER.png') });

      const cli = await ask(en, 'stderr');
      check('слова CLI — дословно, без перевода', cli.trim() === CLI_WORDS, cli);
      check('страница en без ошибок', en.errors.length === 0, en.errors.join(' | '));

      const ru = await openWindow(browser, stand, 'ru');
      const russian = await ask(ru, 'exit');
      check(
        'ru: тот же код — русской строкой',
        russian.trim() === 'CLI завершился с кодом 3 без ответа.',
        russian,
      );
      await ru.screenshot({ path: join(SHOTS, 'error-ru_AFTER.png') });
      check('страница ru без ошибок', ru.errors.length === 0, ru.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
