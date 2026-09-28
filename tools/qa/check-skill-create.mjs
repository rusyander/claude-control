/**
 * Кейс config-resources-003: скилл, созданный формой, — это папка со SKILL.md,
 * и «Команды» видят его сразу со слэшем; удаление убирает папку и строку.
 *
 * Путь настоящий: форма «Создать скилл» одноразового стенда → панель →
 * `skills/probe-skill/SKILL.md` временного каталога конфигурации → раздел
 * «Команды» (фильтр «Скиллы»). Оракул — файл на диске и строка `[data-command]`.
 *
 * Запуск: `node tools/qa/check-skill-create.mjs` (стенд поднимается сам).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const NAME = 'probe-skill';
const DESCRIPTION = 'Use when a probe needs a skill to exist';
const BODY = 'Шаг 1. Ответить «проба».';

await runOnStand({ label: 'skill-create' }, async (stand, check) => {
  const folder = join(stand.cfg, 'skills', NAME);
  const skillFile = join(folder, 'SKILL.md');
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1100 });
    await page.goto(`${stand.webUrl}/skills`, { waitUntil: 'domcontentloaded' });
    const add = page.getByRole('button', { name: 'Создать скилл' }).first();
    await add.waitFor({ timeout: 30_000 });
    await add.click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Имя скилла') });
    await dialog.waitFor();
    await dialog.getByLabel('Имя скилла').fill(NAME);
    await dialog.getByLabel('Описание — когда применять').fill(DESCRIPTION);
    await dialog.getByLabel('Инструкции').fill(BODY);
    await dialog
      .getByRole('button', { name: /^(Сохранить|Создать)/ })
      .last()
      .click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(500);

    check('создание: skills/probe-skill/SKILL.md на диске', existsSync(skillFile));
    const text = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : '';
    check(
      'создание: в SKILL.md имя, описание и тело',
      new RegExp(`name:\\s*["']?${NAME}`).test(text) &&
        text.includes(DESCRIPTION) &&
        text.includes(BODY),
      text,
    );
    check('создание: скилл в списке', (await page.getByText(NAME, { exact: true }).count()) > 0);

    // «Команды», фильтр «Скиллы» — /probe-skill с описанием.
    await page.goto(`${stand.webUrl}/commands`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Скиллы · \d+$/ }).click();
    const row = page.locator(`[data-command="/${NAME}"]`);
    await row.waitFor({ timeout: 15_000 }).catch(() => undefined);
    check('«Команды» → «Скиллы»: есть /probe-skill', (await row.count()) === 1);
    check(
      '«Команды»: у строки описание скилла',
      (await row.count()) === 1 && (await row.innerText()).includes(DESCRIPTION),
      (await row.count()) === 1 ? await row.innerText() : '',
    );

    // Удалить скилл — подтверждение требует имени дословно.
    await page.goto(`${stand.webUrl}/skills`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('button', { name: `Удалить: ${NAME}` })
      .first()
      .click();
    const confirm = page.getByRole('dialog').last();
    await confirm.waitFor();
    const typed = confirm.getByRole('textbox');
    if ((await typed.count()) > 0) await typed.first().fill(NAME);
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);
    check('удаление: папки skills/probe-skill нет', !existsSync(folder));
    await page.goto(`${stand.webUrl}/commands`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Все · \d+$/ }).waitFor({ timeout: 15_000 });
    await wait(800);
    check(
      'удаление: в «Командах» /probe-skill нет',
      (await page.locator(`[data-command="/${NAME}"]`).count()) === 0,
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
