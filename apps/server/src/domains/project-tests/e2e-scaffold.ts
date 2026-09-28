/**
 * Заготовка папки e2e, которую панель заводит в проекте без своих автотестов.
 *
 * Папка самодостаточна: свой `package.json` и свой конфиг Playwright. Так
 * агенту не нужно трогать `package.json` проекта (его права прогона — только
 * папки тестов), а зависимости ставятся ВНУТРЬ папки, которая целиком скрыта
 * от git. Адрес стенда приходит переменной `E2E_BASE_URL` — её выставляет
 * окружение раздела «Тесты», и в файлах проекта он не оседает.
 *
 * Отчёт `results/junit.xml` — не украшение: по нему панель в конце генерации
 * забирает результаты и ставит статусы кейсам (`import-results.ts`).
 */

/** Имя папки, которую заводит панель. */
export const PANEL_E2E_DIR = 'e2e';

/** Где заготовка оставляет отчёт — от корня папки e2e. */
export const E2E_JUNIT_REPORT = 'results/junit.xml';

const CONFIG = `import { defineConfig } from '@playwright/test';

// Created by AgentDeck (Tests section). The stand address comes from E2E_BASE_URL,
// set from the Tests environment; nothing about the stand is stored in this folder.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // One retry: a test that passes only on the second attempt is flaky, not green.
  retries: 1,
  reporter: [['list'], ['junit', { outputFile: '${E2E_JUNIT_REPORT}' }]],
  outputDir: 'results/artifacts',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
`;

const PACKAGE = `${JSON.stringify(
  {
    name: 'e2e',
    private: true,
    type: 'module',
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': '^1.49.0' },
  },
  null,
  2,
)}
`;

const README = `# Автотесты e2e

Папку завела панель AgentDeck (раздел «Тесты»). Она скрыта от git строкой в
\`.git/info/exclude\` и живёт только на этой машине.

- Один файл \`*.spec.ts\` — одна группа проверок (ключевой сценарий: «Авторизация»,
  «Оформление заказа»). Имя теста начинается с id кейса: \`[auth-001] вход по паролю\`.
- Внутри теста — комментарии \`// Given\`, \`// When\`, \`// Then\`: из них панель
  собирает предусловие, шаги и ожидание кейса.
- Метки \`@smoke\` (критичный путь, быстро) и \`@regression\` (всё остальное) — в имени теста.

Запуск из этой папки:

\`\`\`
npm install
npx playwright install chromium
E2E_BASE_URL=http://localhost:3000 npx playwright test
\`\`\`

Отчёт ложится в \`${E2E_JUNIT_REPORT}\`. Панель сводит тесты с кейсами кнопкой
«Обновить из папки» в разделе «Тесты».
`;

/** Файлы заготовки: имя внутри папки → содержимое. */
export const E2E_SCAFFOLD: Record<string, string> = {
  'playwright.config.ts': CONFIG,
  'package.json': PACKAGE,
  'README.md': README,
};
