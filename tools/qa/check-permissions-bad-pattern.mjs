/**
 * Кейс access-integrations-002: шаблон права со скобкой без пары (`Bash(`)
 * отклоняется до записи — с объяснением, а settings.json не меняется.
 *
 * Путь настоящий: форма «Добавить правило» одноразового стенда → панель.
 * settings.json засеян известным содержимым и сравнивается побайтно: «файл не
 * изменился» проверяется файлом, а не тем, что показал экран.
 *
 * Запуск: `node tools/qa/check-permissions-bad-pattern.mjs` (стенд поднимается сам).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const BAD = 'Bash(';
const SEED = `${JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2)}\n`;

await runOnStand(
  {
    label: 'permissions-bad-pattern',
    seed: ({ cfg }) => writeFileSync(join(cfg, 'settings.json'), SEED, 'utf8'),
  },
  async (stand, check) => {
    const file = join(stand.cfg, 'settings.json');
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1200 });
      await page.goto(`${stand.webUrl}/permissions`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Все правила', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить правило' }).first().click();
      const form = page.getByRole('dialog').filter({ has: page.getByLabel('Правило') });
      await form.waitFor({ timeout: 30_000 });
      await form.getByLabel('Правило').fill(BAD);
      await form.getByRole('button', { name: 'Запрещено', exact: true }).click();
      const save = form.getByRole('button', { name: 'Сохранить' });
      let answer;
      if (await save.isEnabled()) {
        const waiting = page
          .waitForResponse(
            (res) => res.url().endsWith('/api/permissions') && res.request().method() === 'POST',
            {
              timeout: 5000,
            },
          )
          .catch(() => undefined);
        await save.click();
        answer = await waiting;
      }
      await wait(700);
      const text = (await form.isVisible()) ? await form.innerText() : '';
      console.log(`  сервер: ${answer ? answer.status() : 'запроса не было'}`);
      check('форма не закрылась «успехом»', await form.isVisible());
      check(
        'отказ объясняет формат (скобки)',
        /скобк/i.test(text),
        text.replace(/\s+/g, ' ').slice(0, 400),
      );
      check(
        'settings.json не изменился ни на байт',
        readFileSync(file, 'utf8') === SEED,
        readFileSync(file, 'utf8'),
      );
      check(
        'страница без необработанных ошибок',
        page.errors.length === 0,
        page.errors.join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
