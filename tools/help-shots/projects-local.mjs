/**
 * Сценарий `projects/local`: в репозитории УЖЕ есть свой `.claude`.
 *
 * Вход другой, чем у `setup`: сюда приходит не тот, кто настраивает проект, а
 * тот, кто открыл чужой репозиторий и хочет понять, что именно Claude Code
 * подхватит из него поверх личного набора — и почему это нельзя выключить
 * тумблером.
 *
 * Три раздела сняты по отдельности не для красоты: каждый показывает свою
 * пометку, которую документ называет словами, — счётчик файлов и «выключен» у
 * скиллов, имя личного файла и битый путь у хуков, маски путей и вложенный
 * каталог у правил. На кадре страницы целиком их не прочитать.
 */
import { PROJECT, PROJECT2, settings, panelShell, open } from './projects-stubs.mjs';

export async function shootLocal(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    const state = {
      projects: [PROJECT, PROJECT2],
      groups: [],
      automations: [],
      rules: [],
      skills: [],
      hooks: [],
      mcp: [],
      permissions: [],
    };

    await settings(page);
    await panelShell(page, state);

    await open(page, web, `/projects?id=${PROJECT.id}`);
    await page.getByRole('button', { name: /^(Из проекта|From the project)$/ }).click();
    await page.waitForTimeout(1000);

    // ── 01. Вкладка целиком: три раздела и пометка «только чтение» ───────────
    await scenario.shot(page, '01-tab');

    // ── 02. Скиллы проекта ───────────────────────────────────────────────────
    // Заголовок раздела и есть его aria-label, а он переведён: английская
    // съёмка снимает ту же секцию под своим именем — оба сразу через CSS-«или».
    await scenario.shot(page, '02-skills', {
      clip: 'section[aria-label="Скиллы"], section[aria-label="Skills"]',
      padding: 140,
    });

    // ── 03. Хуки проекта ─────────────────────────────────────────────────────
    await scenario.shot(page, '03-hooks', {
      clip: 'section[aria-label="Хуки"], section[aria-label="Hooks"]',
      padding: 140,
    });

    // ── 04. Правила проекта с раскрытым текстом ──────────────────────────────
    // Тело правила по умолчанию свёрнуто: раскрываем тем же способом, что и
    // человек, — кнопкой рядом с заголовком.
    await page
      .getByRole('button', { name: /^(Показать текст|Show text): Витрина/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    await scenario.shot(page, '04-rules', {
      clip: 'section[aria-label="Правила"], section[aria-label="Rules"]',
      padding: 140,
    });
  } finally {
    await page.close();
  }
}
