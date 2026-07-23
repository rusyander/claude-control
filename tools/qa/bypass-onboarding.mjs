/**
 * Общий помощник для QA-скриптов: убирает мастер онбординга с дороги теста.
 *
 * Мастер (`OnboardingWizard`) — модалка Radix, которая висит поверх всех
 * страниц, пока в настройках `onboardingDone !== true`, и через focus-trap
 * прячет остальную страницу из дерева доступности (её нельзя закрыть Escape —
 * так задумано). В свежем контексте Playwright это состояние обычное, поэтому
 * без обхода тесты видят только модалку.
 *
 * Обход — чисто клиентский: перехватываем ответ GET /api/settings и подменяем в
 * нём `onboardingDone` на true. Настоящее состояние сервера НЕ меняется (никаких
 * записей), меняется только то, что видит эта вкладка. Вызывать ДО page.goto.
 */
export async function bypassOnboarding(page) {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    let body;
    try {
      body = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    body.onboardingDone = true;
    return route.fulfill({ response, json: body });
  });
}
