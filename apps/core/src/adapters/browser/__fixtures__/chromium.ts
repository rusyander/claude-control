import { chromium } from 'playwright-core';

/**
 * Есть ли Chromium Playwright на этой машине — пробным запуском, а не по пути файла: безголовый
 * режим берёт свою сборку (`headless_shell`), и «файл есть» не значит «запустится». Нет — тесты
 * настоящего браузера пропускаются с причиной (контейнер Linux без браузера), а путь «браузера
 * нет» проверяется отдельно, на любой машине.
 */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

export const NO_CHROMIUM_REASON =
  'Chromium for playwright-core is not installed here (pnpm qa:setup installs it)';
