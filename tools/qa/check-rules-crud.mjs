/**
 * Кейс config-resources-001: правило создаётся, правится и удаляется, а
 * остальной текст CLAUDE.md не трогается; каждая запись видна в «Истории
 * изменений».
 *
 * Путь настоящий: раздел «Правила» одноразового стенда → панель → CLAUDE.md
 * временного каталога конфигурации. Оракул — дифф файла до/после каждого шага:
 * меняется только раздел «## ПРАВИЛО: …», свободный абзац и чужой раздел
 * остаются байт в байт. История — лента `/api/history` и страница «История».
 *
 * Запуск: `node tools/qa/check-rules-crud.mjs` (стенд поднимается сам).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const FREE = 'Свободный абзац человека: его панель не трогает.';
const FOREIGN = '## Заметки\n\nЧужой раздел без метки правила.';
const SEED = `# Мои инструкции\n\n${FREE}\n\n${FOREIGN}\n`;
const TITLE = 'Тестовое правило';
const BODY = 'Отвечай кратко';
const BODY2 = 'Отвечай кратко и по делу';

/** Текст файла без раздела правила — то, что обязано остаться нетронутым. */
const outsideRule = (text) =>
  text.replace(/\n*## ПРАВИЛО: [^\n]*\n[\s\S]*?(?=\n## |\n<!--|$)/g, '').trim();

await runOnStand(
  {
    label: 'rules-crud',
    seed: ({ cfg }) => writeFileSync(join(cfg, 'CLAUDE.md'), SEED, 'utf8'),
  },
  async (stand, check) => {
    const file = join(stand.cfg, 'CLAUDE.md');
    const read = () => readFileSync(file, 'utf8');
    const untouched = outsideRule(SEED);

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/rules`, { waitUntil: 'domcontentloaded' });
      const add = page.getByRole('button', { name: 'Добавить правило' }).first();
      await add.waitFor({ timeout: 30_000 });

      // 1. Создать.
      await add.click();
      let dialog = page.getByRole('dialog', { name: 'Добавить правило' });
      await dialog.waitFor();
      await dialog.getByLabel('Заголовок').fill(TITLE);
      await dialog.getByLabel('Текст правила').fill(BODY);
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      const afterCreate = read();
      check(
        'создание: карточка правила в списке',
        (await page.getByText(TITLE, { exact: true }).count()) > 0,
      );
      check(
        'создание: в CLAUDE.md раздел «## ПРАВИЛО: Тестовое правило» с текстом',
        new RegExp(`## ПРАВИЛО: ${TITLE}\\s*\\n+${BODY}\\s*(\\n|$)`).test(afterCreate),
        afterCreate,
      );
      check(
        'создание: свободный абзац и чужой раздел на месте',
        outsideRule(afterCreate) === untouched,
        outsideRule(afterCreate),
      );

      // 2. Изменить текст.
      await page.getByRole('button', { name: `Редактировать: ${TITLE}` }).click();
      dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Текст правила') });
      await dialog.waitFor();
      await dialog.getByLabel('Текст правила').fill(BODY2);
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      await wait(400);
      const afterEdit = read();
      check(
        'правка: в файле новый текст правила',
        afterEdit.includes(BODY2) &&
          !new RegExp(`${BODY}\\s*(\\n|$)`).test(afterEdit.replace(BODY2, '')),
        afterEdit,
      );
      check(
        'правка: остальное без изменений',
        outsideRule(afterEdit) === untouched,
        outsideRule(afterEdit),
      );

      // 3. Удалить — подтверждение требует имени дословно.
      await page.getByRole('button', { name: `Удалить: ${TITLE}` }).click();
      const confirm = page.getByRole('dialog').last();
      await confirm.waitFor();
      const typed = confirm.getByRole('textbox');
      if ((await typed.count()) > 0) await typed.first().fill(TITLE);
      await confirm.getByRole('button', { name: 'Удалить' }).click();
      await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      await wait(400);
      const afterDelete = read();
      check(
        'удаление: раздела правила нет',
        !afterDelete.includes(`ПРАВИЛО: ${TITLE}`),
        afterDelete,
      );
      check(
        'удаление: свободный абзац и чужой раздел на месте',
        afterDelete.includes(FREE) &&
          afterDelete.includes(FOREIGN) &&
          outsideRule(afterDelete) === untouched,
        afterDelete,
      );
      check(
        'удаление: карточки нет в списке',
        (await page.getByText(TITLE, { exact: true }).count()) === 0,
      );

      // 4. История: три записи по CLAUDE.md, у каждой ненулевой дифф.
      const history = await stand.api('/history');
      const entries = (history.body?.items ?? []).filter((item) => item.file === 'CLAUDE.md');
      check(
        'история: ровно три записи по CLAUDE.md',
        entries.length === 3,
        JSON.stringify(entries.map(({ name, added, removed }) => ({ name, added, removed }))),
      );
      check(
        'история: у каждой записи есть дифф (+N/−M не нули)',
        entries.length > 0 && entries.every((item) => item.added + item.removed > 0),
        JSON.stringify(entries.map(({ added, removed }) => [added, removed])),
      );
      await page.goto(`${stand.webUrl}/history`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'История изменений' }).waitFor({ timeout: 30_000 });
      await wait(1500);
      const shown = await page.getByText('CLAUDE.md', { exact: true }).count();
      check('история: страница показывает записи по CLAUDE.md', shown >= 3, `показано: ${shown}`);
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
