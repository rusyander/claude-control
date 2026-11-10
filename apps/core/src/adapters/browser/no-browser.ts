/**
 * Chromium не установлен (P177): отказ `no-browser` называет команду установки для ЭТОЙ ОС, а не
 * общий «поставьте браузер». Версия браузера — та, что ждёт `playwright-core` ядра: он прибит к
 * версии корневого `playwright`, поэтому команда корня (`pnpm qa:setup`) ставит ровно его.
 * На Linux `--with-deps` ставит системные библиотеки через `sudo` — без прав root команда
 * без `--with-deps`, а библиотеки — отдельной строкой, иначе человек упрётся в пароль молча.
 */

export function installCommandFor(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return (
      'pnpm exec playwright install chromium (system libraries: ' +
      'sudo pnpm exec playwright install-deps chromium)'
    );
  }
  return 'pnpm qa:setup (playwright install --with-deps chromium)';
}

/** Сообщение запуска Playwright, когда исполняемого файла браузера нет на месте. */
const MISSING = [/executable doesn't exist/i];

export function isMissingBrowser(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return MISSING.some((re) => re.test(text));
}

export function noBrowserMessage(platform: NodeJS.Platform): string {
  return `Chromium for the core browser is not installed; install it with: ${installCommandFor(platform)}`;
}
