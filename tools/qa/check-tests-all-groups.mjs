/**
 * Кейсы testing-025 и testing-026: сквозной список «Все группы» и
 * проверка конца хода агента, поставленная панелью.
 *
 * 1. Добавление проекта ставит хуки блока «Тесты» в `.claude/settings.local.json`
 *    проекта; вкладка «Агенты» настроек набора выключает их (файл уходит, как и
 *    не был) и включает снова.
 * 2. «Все группы» показывает кейсы всех файлов одним списком, с колонкой группы
 *    и без отметок. Одинаковый id кейса в двух группах — главный риск
 *    сквозного списка: правка и удаление обязаны попасть в файл СВОЕЙ строки,
 *    а не в выбранную группу.
 * 3. Отрицательная сторона: у проекта с одной группой строки «Все группы» нет.
 *
 * Путь настоящий: одноразовый стенд, POST /projects, страница «Тестирование».
 * Оракул — файлы проекта.
 *
 * Запуск: `node tools/qa/check-tests-all-groups.mjs` (стенд поднимается сам).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const caseOf = (title) => ({
  id: 'dup-001',
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открылось' }],
});
const writeGroup = (dir, id, title, cases) =>
  writeFileSync(
    join(dir, `${id}.tests.json`),
    `${JSON.stringify({ version: 1, title, cases }, null, 2)}\n`,
    'utf8',
  );

await runOnStand(
  {
    label: 'tests-all-groups',
    seed: ({ home }) => {
      const dir = join(home, 'proj', '.agent', 'tests');
      mkdirSync(dir, { recursive: true });
      writeGroup(dir, 'alpha', 'Альфа', [caseOf('Кейс альфы')]);
      writeGroup(dir, 'beta', 'Бета', [caseOf('Кейс беты')]);
      const solo = join(home, 'solo', '.agent', 'tests');
      mkdirSync(solo, { recursive: true });
      writeGroup(solo, 'only', 'Единственная', [caseOf('Один кейс')]);
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const tests = join(project, '.agent', 'tests');
    const group = (id) => JSON.parse(readFileSync(join(tests, `${id}.tests.json`), 'utf8'));
    const settingsFile = join(project, '.claude', 'settings.local.json');

    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check('временный проект заведён в реестр', added.status === 200, `${added.status}`);

    // 1. Хуки поставлены добавлением проекта.
    const settings = existsSync(settingsFile)
      ? JSON.parse(readFileSync(settingsFile, 'utf8'))
      : undefined;
    const stop = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? '';
    check(
      'добавление проекта поставило проверку конца хода',
      /tests-hook\.mjs" stop$/.test(stop),
      stop,
    );
    check(
      'и строку начала сессии',
      /tests-hook\.mjs" session$/.test(
        settings?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '',
      ),
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: 'Изменить группу' })
        .first()
        .waitFor({ timeout: 30_000 });

      // Вкладка «Агенты»: выключить — файла нет; включить — снова есть.
      await page.getByRole('button', { name: 'Настройки набора' }).click();
      const dialog = page.getByRole('dialog', { name: 'Настройки набора' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Агенты' }).click();
      const toggle = dialog.getByRole('switch', { name: 'Проверять конец хода агента' });
      await toggle.waitFor();
      // Пока статус хуков грузится, переключатель неактивен и не отмечен —
      // читать его состояние имеет смысл только после загрузки.
      for (let left = 50; left > 0 && (await toggle.isDisabled()); left -= 1) await wait(200);
      check(
        'переключатель показывает «включена»',
        (await toggle.getAttribute('aria-checked')) === 'true',
      );
      await toggle.click();
      await wait(800);
      check('выключение убрало файл, которого до панели не было', !existsSync(settingsFile));
      const off = await stand.api(`/project-tests/turn-hooks?path=${encodeURIComponent(project)}`);
      check('сервер помнит «выключена»', off.body?.state === 'off', JSON.stringify(off.body));
      await toggle.click();
      await wait(800);
      check('включение вернуло хуки', existsSync(settingsFile));
      await page.keyboard.press('Escape');

      // 2. «Все группы»: обе строки с одинаковым id, колонка группы, без отметок.
      await page.getByRole('button', { name: /^Все группы/ }).click();
      const rows = page.locator('table tbody tr');
      await wait(500);
      check('в сквозном списке обе строки', (await rows.count()) === 2, `${await rows.count()}`);
      check(
        'колонка «Группа» есть',
        (await page.getByRole('columnheader', { name: 'Группа' }).count()) === 1,
      );
      check(
        'колонки отметок нет',
        (await page.getByRole('checkbox', { name: 'Кейс беты' }).count()) === 0,
      );

      // Правка строки беты ложится в бету, альфа не тронута.
      const betaRow = rows.filter({ hasText: 'Кейс беты' });
      await betaRow.getByRole('button', { name: 'Правка теста' }).click();
      const editor = page.getByRole('dialog', { name: 'Правка теста' });
      await editor.waitFor();
      await editor.getByRole('textbox', { name: /Что проверяем/ }).fill('Кейс беты, правка');
      await editor.getByRole('button', { name: 'Сохранить' }).click();
      await editor.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      await wait(600);
      check(
        'правка из сквозного списка — в файле беты',
        group('beta').cases[0]?.title === 'Кейс беты, правка',
        group('beta').cases[0]?.title,
      );
      check(
        'файл альфы не тронут',
        group('alpha').cases[0]?.title === 'Кейс альфы',
        group('alpha').cases[0]?.title,
      );

      // Удаление строки беты удаляет кейс беты, а не одноимённый в альфе.
      await rows
        .filter({ hasText: 'Кейс беты' })
        .getByRole('button', { name: 'Удалить тест' })
        .click();
      await page
        .getByRole('dialog', { name: /Удалить тест/ })
        .getByRole('button', { name: 'Удалить' })
        .click();
      await wait(800);
      check(
        'удаление из сквозного списка — из беты',
        group('beta').cases.length === 0,
        `${group('beta').cases.length}`,
      );
      check(
        'кейс альфы с тем же id на месте',
        group('alpha').cases.length === 1,
        `${group('alpha').cases.length}`,
      );

      // 3. Одна группа — строки «Все группы» нет.
      const solo = join(stand.home, 'solo');
      const soloAdded = await stand.api('/projects', { method: 'POST', body: { path: solo } });
      check('второй проект заведён', soloAdded.status === 200, `${soloAdded.status}`);
      await page.goto(`${stand.webUrl}/tests?project=${encodeURIComponent(solo)}`, {
        waitUntil: 'domcontentloaded',
      });
      await page
        .getByRole('button', { name: /Единственная/ })
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      check(
        'открыт проект с одной группой',
        (await page.getByRole('button', { name: /Единственная/ }).count()) > 0,
      );
      check(
        'у проекта с одной группой строки «Все группы» нет',
        (await page.getByRole('button', { name: /^Все группы/ }).count()) === 0,
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
