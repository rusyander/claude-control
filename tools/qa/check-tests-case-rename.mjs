/**
 * Кейс testing-003: правка описания кейса не стирает результат прогона.
 *
 * Результат прогона (`status`, `note`, время и номер прогона) пишет прогон, а не
 * форма; сохранение формы сводится по `id` с тем, что лежит на диске. Если форма
 * пошлёт свой `status` или пустую заметку — красный кейс станет «неизвестным», и
 * человек потеряет то, что увидели в прогоне. Поэтому проверка кладёт в файл
 * группы кейс, УЖЕ проваленный прогоном, переименовывает его через настоящую
 * форму одноразового стенда и читает файл обратно.
 *
 * Результат прогона кладётся в файл напрямую — это внешняя граница (так его
 * оставляет прогон), а всё, что проверяется, идёт через панель.
 *
 * Запуск: `node tools/qa/check-tests-case-rename.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const NOTE = 'Ответ не пришёл за 30 с: лента пустая, в консоли 502';
const RUN = { lastRunAt: '2026-09-20T10:00:00.000Z', lastRunId: 'run-qa-1' };
const OLD_TITLE = 'Сообщение уходит';
const NEW_TITLE = 'Сообщение уходит и приходит ответ';

await runOnStand(
  {
    label: 'tests-case-rename',
    seed: ({ home }) => {
      const dir = join(home, 'proj', '.agent', 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'chat.tests.json'),
        `${JSON.stringify(
          {
            version: 1,
            title: 'Чат',
            cases: [
              {
                id: 'chat-001',
                type: 'case',
                title: OLD_TITLE,
                steps: [{ action: 'Отправить «пинг»', expected: 'Ответ в ленте' }],
                expected: 'Ответ пришёл',
                priority: 'high',
                status: 'failed',
                note: NOTE,
                ...RUN,
                source: 'human',
                updatedAt: '2026-09-20T10:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const groupFile = join(project, '.agent', 'tests', 'chat.tests.json');
    await stand.api('/projects', { method: 'POST', body: { path: project } });

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const row = page.getByRole('row').filter({ hasText: OLD_TITLE });
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Правка теста' }).click();
      const edit = page.getByRole('dialog', { name: 'Правка теста' });
      await edit.waitFor();
      await wait(300);
      check(
        'форма показывает, что увидели в прогоне',
        (await edit.getByLabel('Что увидели в прогоне').inputValue()) === NOTE,
      );
      await edit.getByLabel('Что проверяем').fill(NEW_TITLE);
      await edit.getByRole('button', { name: 'Сохранить' }).click();
      await edit.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      check('форма закрылась после сохранения', !(await edit.isVisible()));

      const item = JSON.parse(readFileSync(groupFile, 'utf8')).cases.find(
        (c) => c.id === 'chat-001',
      );
      check('в файле название новое', item?.title === NEW_TITLE, `title: ${item?.title}`);
      check('в файле статус остался failed', item?.status === 'failed', `status: ${item?.status}`);
      check('в файле заметка прогона на месте', item?.note === NOTE, `note: ${item?.note}`);
      check(
        'в файле время и номер прогона на месте',
        item?.lastRunAt === RUN.lastRunAt && item?.lastRunId === RUN.lastRunId,
        `${item?.lastRunAt} ${item?.lastRunId}`,
      );

      // И на экране после F5: строка с новым названием помечена проваленной.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const renamed = page.getByRole('row').filter({ hasText: NEW_TITLE });
      await renamed.waitFor({ timeout: 30_000 });
      const rowText = await renamed.innerText();
      check(
        'после F5 строка показывает провал',
        /провал/i.test(rowText),
        rowText.replace(/\s+/g, ' '),
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
