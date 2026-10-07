/**
 * Живой список процессов под Codex и Qwen Code (Z-fix 3, 07.10.2026).
 *
 * Под этими CLI отчёт аналитики уже их собственный, а `/api/analytics/live`
 * отдавал процессы `claude` — блок «Работают прямо сейчас» выдавал их за
 * процессы активного CLI. Решение владельца: только процессы активного CLI;
 * опознать их надёжно нельзя — значит пустой список с честной причиной.
 *
 * Свидетели — на одноразовых стендах, обход процессов НАСТОЯЩИЙ:
 *   - контроль Claude: список не пуст (на машине работает хотя бы тот claude,
 *     что ведёт эту проверку) — иначе пустота ниже ничего бы не доказывала;
 *   - Codex и Qwen Code: `runningAgents` пуст, `unavailable` с кодом
 *     `analytics-live-foreign` и именем CLI;
 *   - в браузере вкладка «Агенты и контур» показывает причину, а не PID.
 *
 * Настоящие `~/.claude`, `~/.codex`, `~/.qwen` не читаются и не пишутся (дом
 * стенда временный); сеть и установленные CLI не нужны.
 *
 * Запуск: node tools/qa/check-analytics-live-foreign.mjs
 */
import { chromium } from 'playwright';
import { startStand } from './throwaway-stand.mjs';

let bad = 0;
const check = (text, ok, detail) => {
  console.log(
    `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) bad += 1;
  return ok;
};

async function scenario(browser, provider, name) {
  console.log(`\n— ${name}`);
  const stand = await startStand({ label: `live-${provider}`, settings: { provider } });
  try {
    const live = await stand.api('/analytics/live');
    const agents = live.body?.runningAgents ?? [];
    if (provider === 'claude') {
      check('ответ 200', live.status === 200, live.text);
      check('процессы claude найдены (контроль обхода)', agents.length > 0, live.text);
      check('пометки о недоступности нет', live.body?.unavailable === undefined, live.text);
      return;
    }
    check('ответ 200', live.status === 200, live.text);
    check('список процессов пуст', agents.length === 0, live.text);
    check(
      'причина с кодом analytics-live-foreign',
      live.body?.unavailable?.messageCode === 'analytics-live-foreign',
      live.text,
    );
    check(
      `причина называет ${name}`,
      String(live.body?.unavailable?.params?.provider ?? '').startsWith(name),
      live.text,
    );

    const page = await stand.newPage(browser, { height: 1000 });
    await page.goto(`${stand.webUrl}/analytics?tab=live`, { waitUntil: 'domcontentloaded' });
    const card = page.getByText('Работают прямо сейчас').first();
    await card.waitFor({ timeout: 30_000 });
    const reason = page.getByText('Процессы на машине панель опознаёт только у Claude Code');
    const shown = await reason
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const body = await page.locator('main').innerText();
    check('карточка показывает причину', shown, body.slice(0, 800));
    // PID лежат в свёрнутом <details> и в innerText не попадают — свидетель
    // списка процессов здесь его заголовок «Показать процессы — N шт.».
    const listed = await page.locator('details summary', { hasText: 'Показать процессы' }).count();
    check('в карточке нет списка процессов', listed === 0, body.slice(0, 800));
    await page.close();
  } finally {
    await stand.stop();
  }
}

const browser = await chromium.launch();
try {
  await scenario(browser, 'claude', 'Claude Code');
  await scenario(browser, 'codex', 'Codex');
  await scenario(browser, 'qwen', 'Qwen Code');
} finally {
  await browser.close();
}
console.log(bad ? `\nРасхождений: ${bad}` : '\nВсё сходится.');
process.exit(bad ? 1 : 0);
