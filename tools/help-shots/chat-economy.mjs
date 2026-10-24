/**
 * Кадр раздела «Экономия групп разделения» в документе «Чат»: `chat/economy`,
 * русский и английский за один прогон; тёмная тема — тем же скриптом с
 * `GUIDE_THEME=dark`.
 *
 * Что на кадре: строка «Где действует:» под рычагом «Новый разговор после долгой
 * паузы» в карточке «Экономия групп разделения» («Настройки» → «Группы»). Рычаг
 * выбран потому, что в его строке все виды отметок разом: зелёная «ключом CLI»,
 * синяя «силами панели», «с условием» (`data-condition`) и приглушённые. Карточка
 * целиком выше окна и уходит под липкую полосу вкладок — кадр берёт одну строку.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`), и НИЧЕГО НЕ ПОДМЕНЕНО:
 * отметки строятся из `ProviderInfo.groupEconomy` настоящих каталогов CLI.
 * Подмена `/api/providers` сняла бы выдуманные отметки, а кадр должен показывать
 * те, что объявили каталоги.
 *
 * Запуск: node tools/help-shots/chat-economy.mjs
 *         GUIDE_THEME=dark node tools/help-shots/chat-economy.mjs
 */
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { SHOT_LANGS, applyShotLanguage, openScenario, shotTheme } from './kit.mjs';
import { shotCard } from './access-providers-fixture.mjs';

const ROW = '[data-lever="freshOnColdResume"]';

const stand = await startStand({ label: 'economy-shots', settings: { theme: shotTheme() } });

async function shoot(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${stand.webUrl}/settings?tab=groups`, { waitUntil: 'domcontentloaded' });
    // Отметки приходят вторым запросом (`/api/providers`) — ждём их, а не карточку.
    await page.waitForSelector(`${ROW} [data-support]`, { timeout: 20_000 });
    await page.waitForSelector(`${ROW} [data-condition]`, { timeout: 10_000 });
    await page.mouse.move(5, 5);
    await wait(800);
    await shotCard(scenario, page, '01-where', ROW, 12);
  } finally {
    await context.close();
  }
}

let exitCode = 0;
try {
  const browser = await chromium.launch();
  try {
    for (const lang of SHOT_LANGS) {
      await applyShotLanguage(stand.apiUrl, lang);
      const scenario = openScenario('chat', 'economy', lang);
      console.log(`\nсценарий chat/economy [${lang}]`);
      await shoot(browser, scenario);
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stand.stop();
}
process.exit(exitCode);
