/**
 * Сценарий `projects/setup`: папка становится проектом.
 *
 * Путь ровно тот, который человек проходит сам: пустой раздел → обзор дисков →
 * выбранная папка в реестре → три вкладки её конфигурации (правила, MCP, права)
 * → тот же реестр глазами другого CLI, у которого проектные файлы свои.
 *
 * Реестр в кадре 1 ПУСТ по-настоящему: заглушка держит список проектов в
 * памяти, и «Открыть эту папку» добавляет запись тем же запросом, что и на
 * живом сервере. Готовый список показал бы человеку экран, до которого он в
 * панели не доходил.
 */
import { PROJECT, settings, panelShell, open } from './projects-stubs.mjs';

/** Что панель знает о проекте у ЧУЖОГО CLI: разделы решает сервер, не клиент. */
const CODEX_PROJECT = {
  providerId: 'codex',
  providerName: 'Codex CLI',
  projectPath: PROJECT.path,
  sections: ['instructions', 'mcp'],
  instructionsFileName: 'AGENTS.md',
  instructionsPath: `${PROJECT.path}/AGENTS.md`,
  mcpFormat: 'toml',
  mcpPath: `${PROJECT.path}/.codex/config.toml`,
};

const CODEX_INSTRUCTIONS = {
  content: [
    '# Витрина магазина',
    '',
    'Тот же проект, но инструкции лежат в AGENTS.md: у каждого CLI свой файл.',
    '',
    '- Правки точечные, ответы по-русски.',
    '- Каталог migrations не трогать.',
    '',
  ].join('\n'),
  exists: true,
  fileName: 'AGENTS.md',
  filePath: `${PROJECT.path}/AGENTS.md`,
  providerId: 'codex',
  providerName: 'Codex CLI',
};

export async function shootSetup(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });

  try {
    const state = {
      // Реестр пуст: сценарий начинается с раздела, в котором ещё ничего нет.
      projects: [],
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

    // ── 01. Раздел без единого проекта ───────────────────────────────────────
    await open(page, web, '/projects');
    await scenario.shot(page, '01-empty');

    // ── 02. Обзор папок ──────────────────────────────────────────────────────
    await page.getByRole('button', { name: /^(Добавить проект|Add project)$/ }).click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(600);
    // Корень показан дважды: чипом быстрых корней и строкой списка — берём
    // первый попавшийся, человеку разницы нет.
    await page.getByRole('button', { name: 'C:\\', exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'work', exact: true }).first().click();
    await page.waitForTimeout(800);
    await scenario.shot(page, '02-picker', { clip: '[role="dialog"]', padding: 60 });

    // Папку выбираем ту же, вокруг которой идёт весь путеводитель: её имя
    // подставит сам обзор — короткое имя проекта берётся из последнего сегмента.
    await page.getByRole('button', { name: 'shop-front', exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^(Открыть эту папку|Open this folder)$/ }).click();
    // Ждём, пока уедет всплывающее «Создано»: оно правдиво, но закрывает угол
    // с кнопками сохранения, о которых говорит следующий шаг.
    await page.waitForTimeout(7000);

    // ── 03. Правила проекта: его CLAUDE.md целиком ───────────────────────────
    await scenario.shot(page, '03-rules');

    // ── 04. MCP-серверы проекта из его .mcp.json ─────────────────────────────
    await page.getByRole('button', { name: /^(MCP-серверы|MCP servers)$/ }).click();
    await page.waitForTimeout(900);
    await scenario.shot(page, '04-mcp');

    // ── 05. Права проекта из .claude/settings.json ───────────────────────────
    await page.getByRole('button', { name: /^(Права|Permissions)$/ }).click();
    await page.waitForTimeout(900);
    await scenario.shot(page, '05-permissions');

    // ── 06. Тот же реестр у чужого CLI ───────────────────────────────────────
    // Реестр проектов общий, а конфиг у каждого CLI свой: вкладки называются
    // его файлами. Провайдер меняется в настройках, поэтому страница читается
    // заново — как и после переключения провайдера в живой панели.
    await settings(page, { provider: 'codex' });
    await page.route('**/api/projects/*/provider', (route) =>
      route.fulfill({ json: CODEX_PROJECT }),
    );
    await page.route('**/api/projects/*/provider/instructions', (route) =>
      route.fulfill({ json: CODEX_INSTRUCTIONS }),
    );
    await open(page, web, `/projects?id=${PROJECT.id}`);
    await page.waitForTimeout(1200);
    await scenario.shot(page, '06-foreign');
  } finally {
    await page.close();
  }
}
