/**
 * Права OpenCode: чтение файлов (`read`) — своя строка формы и свой список
 * шаблонов, отдельный от шаблонов команд `bash`.
 *
 * Живая проба 09.10.2026 (OpenCode 1.18.35): `permission.read` OpenCode
 * применяет, а шаблон сверяет с полным путём. До правки панель `read` не вела, а
 * форма держала ОДИН список шаблонов на все инструменты: второй инструмент с
 * картой показал бы и записал чужие строки.
 *
 * Путь человека в настоящем фронте на своём одноразовом стенде (активный CLI —
 * OpenCode, дом временный, сам `opencode` не нужен — раздел читает и пишет файл):
 *   1. в файле у `bash` карта из двух шаблонов → строка «Чтение файлов (read)»
 *      есть, у неё «не задано», подсказка про полный путь видна после выбора;
 *   2. у `read` выбрать «по шаблонам» → в его списке ОДНА строка `*`, а не
 *      шаблоны `bash`; вписать `**` + `/.env`, уровень deny, сохранить — в
 *      окне «Что будет записано» дифф с картой `read`, «Записать»;
 *   3. в файле у `read` карта из одного этого шаблона с deny, у `bash` прежняя.
 *
 * Запуск: `node tools/qa/check-opencode-read-permission.mjs`
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'opencode-read-permission');
mkdirSync(SHOTS, { recursive: true });

const BASH = { '*': 'ask', 'git push *': 'deny' };
const READ_PATTERN = '**/.env';
const configFile = (home) => join(home, '.config', 'opencode', 'opencode.json');

await runOnStand(
  {
    label: 'oc-read-perm',
    settings: { provider: 'opencode' },
    seed: ({ home }) => {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      writeFileSync(
        configFile(home),
        JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { bash: BASH } }),
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await bypassOnboarding(page, { provider: 'opencode' });
      await page.goto(`${stand.webUrl}/permissions`);
      const readRow = page.locator('[data-opencode-tool="read"]');
      const bashRow = page.locator('[data-opencode-tool="bash"]');
      await readRow.waitFor({ timeout: 30_000 });

      const readSelect = readRow.getByLabel('Чтение файлов (read)');
      check('строка «Чтение файлов (read)» есть', (await readSelect.count()) === 1);
      check('у read — «не задано»', (await readSelect.inputValue()) === 'unset');
      check(
        'у bash — карта из двух шаблонов',
        (await bashRow.getByLabel('Шаблон').count()) === 2,
        String(await bashRow.getByLabel('Шаблон').count()),
      );

      await readSelect.selectOption('patterns');
      const readPatterns = readRow.getByLabel('Шаблон');
      check(
        'у read свой список: одна строка «*», а не шаблоны bash',
        (await readPatterns.count()) === 1 && (await readPatterns.first().inputValue()) === '*',
        `${await readPatterns.count()} / ${await readPatterns.first().inputValue()}`,
      );
      check(
        'подсказка read — про путь файла, пример «**/.env»',
        (await readPatterns.first().getAttribute('placeholder'))?.includes(READ_PATTERN) &&
          (await readRow.textContent())?.includes('полным путём'),
      );
      check('у bash по-прежнему два шаблона', (await bashRow.getByLabel('Шаблон').count()) === 2);

      await readPatterns.first().fill(READ_PATTERN);
      await readRow.getByLabel('Уровень').first().selectOption('deny');
      await page.screenshot({ path: join(SHOTS, 'read-row_AFTER.png'), fullPage: true });
      // Запись идёт через окно «Что будет записано» с диффом файла.
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 15_000 });
      // Дифф считается запросом после открытия окна.
      await dialog
        .getByText(`"${READ_PATTERN}"`)
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
      const diff = (await dialog.textContent()) ?? '';
      check(
        'в диффе — карта read с «**/.env»',
        diff.includes('"read"') && diff.includes(`"${READ_PATTERN}"`),
      );
      await page.screenshot({ path: join(SHOTS, 'write-diff_AFTER.png') });
      const put = page.waitForResponse(
        (res) =>
          res.url().includes('/api/provider-permissions') && res.request().method() === 'PUT',
        { timeout: 15_000 },
      );
      await dialog.getByRole('button', { name: 'Записать' }).click();
      const answer = await put.catch(() => undefined);
      check(
        'запись принята сервером',
        answer?.status() === 200,
        `${answer?.status()} ${await answer?.text().catch(() => '')}`,
      );

      let saved;
      for (let i = 0; i < 50; i += 1) {
        saved = JSON.parse(readFileSync(configFile(stand.home), 'utf8'));
        if (saved.permission?.read) break;
        await new Promise((done) => setTimeout(done, 200));
      }
      check(
        'в файле read — карта путей с запретом',
        JSON.stringify(saved?.permission?.read) === JSON.stringify({ [READ_PATTERN]: 'deny' }),
        JSON.stringify(saved?.permission),
      );
      check(
        'в файле bash — прежняя карта',
        JSON.stringify(saved?.permission?.bash) === JSON.stringify(BASH),
        JSON.stringify(saved?.permission?.bash),
      );
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
