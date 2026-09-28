/**
 * Кейс config-resources-002: правило с пустым заголовком или с заголовком,
 * который уже есть, отклоняется с понятным текстом, и CLAUDE.md не меняется ни
 * в одном из случаев.
 *
 * Путь настоящий: форма «Добавить правило» одноразового стенда → панель →
 * CLAUDE.md временного каталога конфигурации. Оракул — байты файла до и после.
 *
 * Запуск: `node tools/qa/check-rules-validation.mjs` (стенд поднимается сам).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const TITLE = 'Тестовое правило';
const SEED = `# Мои инструкции\n\nСвободный абзац.\n\n## ПРАВИЛО: ${TITLE}\n\nОтвечай кратко\n`;

await runOnStand(
  {
    label: 'rules-validation',
    seed: ({ cfg }) => writeFileSync(join(cfg, 'CLAUDE.md'), SEED, 'utf8'),
  },
  async (stand, check) => {
    const file = join(stand.cfg, 'CLAUDE.md');
    const read = () => readFileSync(file, 'utf8');

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/rules`, { waitUntil: 'domcontentloaded' });
      await page.getByText(TITLE, { exact: true }).first().waitFor({ timeout: 30_000 });
      const open = async () => {
        await page.getByRole('button', { name: 'Добавить правило' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Добавить правило' });
        await dialog.waitFor();
        return dialog;
      };

      // 1. Пустой заголовок: сохранить нельзя (кнопка недоступна) либо отказ «нужен заголовок».
      let dialog = await open();
      await dialog.getByLabel('Заголовок').fill('   ');
      await dialog.getByLabel('Текст правила').fill('Текст без заголовка');
      const save = dialog.getByRole('button', { name: 'Сохранить' });
      const disabled = await save.isDisabled();
      if (!disabled) {
        await save.click();
        await wait(800);
      }
      const emptyText = (await dialog.isVisible()) ? await dialog.innerText() : '';
      check(
        'пустой заголовок: сохранение недоступно или отказ называет заголовок',
        disabled || /заголов/i.test(emptyText),
        `кнопка активна; окно: ${emptyText.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      check('пустой заголовок: CLAUDE.md не изменился', read() === SEED, read());
      await dialog.getByRole('button', { name: 'Отмена' }).click();

      // 2. Дубль «Тестовое правило»: отказ, называющий дубль.
      dialog = await open();
      await dialog.getByLabel('Заголовок').fill(TITLE);
      await dialog.getByLabel('Текст правила').fill('Второе правило с тем же именем');
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await wait(1500);
      const stillOpen = await dialog.isVisible();
      const dupText = stillOpen ? await dialog.innerText() : '';
      check(
        'дубль: окно не закрылось, отказ называет повтор заголовка',
        stillOpen &&
          dupText.includes(TITLE) &&
          /(уже есть|уже существует|такое правило|дубл|повтор)/i.test(dupText),
        stillOpen
          ? dupText.replace(/\s+/g, ' ').slice(0, 300)
          : 'окно закрылось как после успешного сохранения',
      );
      check('дубль: CLAUDE.md не изменился', read() === SEED, read());
      const cards = await page.getByText(TITLE, { exact: true }).count();
      check('дубль: в списке одна карточка с этим именем', cards === 1, `карточек: ${cards}`);
    } finally {
      await browser.close();
    }
  },
);
