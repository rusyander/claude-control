/**
 * Окно сайта в чате переживает перезапуск цели честно (этап 12, V1, D20) — живой фронт `pnpm dev`,
 * реестр запусков и ответы окна подменены `page.route` (`stubChatSite` из `panel-pages.mjs`): на
 * стенде нет ни запущенной панелью цели, ни прокси. Окно, полосу и опрос реестра рисует настоящий
 * код панели.
 *
 * Перезапуск цели между двумя опросами реестра (раз в 2 с) — тот же путь, новый порт и время старта.
 * Прокси прежнего запуска сервер к этому времени закрыл, так что окно на его адресе — мёртвая рамка.
 *
 * Что видно:
 *   - окно открыто над запуском (порт 5999);
 *   - цель перезапущена между опросами (порт 6001) — окно сайта закрылось само, полоса «Сайт:» на
 *     месте и называет новый адрес, открыть заново можно;
 *   - цель остановлена — окно закрыто, полосы нет; ошибок страницы нет.
 *
 * Запуск: `node tools/qa/check-site-preview-restart.mjs` при поднятом `pnpm dev` (`APP_URL` — другой
 * фронт). Код выхода: 0 — сходится, 1 — провал.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { openPanelPage, stubChatSite, openChatSite } from './panel-pages.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};
const until = async (probe, ms) => {
  for (let at = 0; at < ms; at += 250) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return probe();
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));
  await bypassOnboarding(page);
  const run = { port: 5999, startedAt: '2026-11-09T09:00:00.000Z', status: 'running' };
  await openPanelPage(page, BASE, {
    path: '/chat',
    prepare: (p) => stubChatSite(p, run),
    ready: '[data-site-open]',
    interact: openChatSite,
  });
  const pane = page.locator('[data-site-preview]');
  const strip = page.locator('[data-site-open]');
  check('окно открыто над запуском', (await pane.count()) === 1);

  // Перезапуск между опросами: тот же путь цели, новый порт и время старта.
  Object.assign(run, { port: 6001, startedAt: '2026-11-09T09:05:00.000Z' });
  check(
    'цель перезапущена между опросами — окно сайта закрылось само',
    await until(async () => (await pane.count()) === 0, 6000),
  );
  check(
    'полоса «Сайт:» на месте и называет новый адрес',
    (await strip.count()) === 1 && ((await strip.textContent()) ?? '').includes(':6001'),
    String(await strip.textContent().catch(() => '')),
  );
  await strip.click();
  check('открыть заново можно', await until(async () => (await pane.count()) === 1, 5000));

  run.status = 'stopped';
  check(
    'цель остановлена — окна и полосы нет',
    await until(async () => (await pane.count()) === 0 && (await strip.count()) === 0, 6000),
  );
  check('ошибок страницы нет', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
}
console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
