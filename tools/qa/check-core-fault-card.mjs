/**
 * Карточка сбоя ядра (этап 10, зона core-supervisor) — настоящая дорога браузера: одноразовая
 * панель с надзором, ядро поднимает ПАНЕЛЬ, а настройка ядра сломана — ядро падает на загрузке
 * раз за разом. Подменено только окружение (временные дома); ответы панели не перехватываются.
 *
 * Что видно:
 * 1. Надзор сдаётся после пяти падений за 10 минут: `/api/core/supervisor` = `fault`.
 * 2. Раздел `/core` — карточка сбоя: заголовок «не запускается», хвост журнала ядра с причиной
 *    падения (секреты скрыты), «Перезапустить»; слов «pnpm core» нет.
 * 3. Настройку починили, нажали «Перезапустить» — ядро поднялось, раздел показал список задач
 *    (пустой), карточки нет.
 *
 * Запуск: `node tools/qa/check-core-fault-card.mjs` (стенд свой, `pnpm dev` не нужен).
 * `SHOTS=<dir>` — кадры в обеих темах. Код выхода: 0 / 1 провал / 2 стенд не поднялся.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { killProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';
import { DEFAULT_CORE_STUBS, runOnStand } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
const coreHome = mkdtempSync(join(tmpdir(), 'cc-core-fault-home-'));
// Ключ в окружении, который падение могло бы напечатать, — его в журнале быть не должно.
writeFileSync(join(coreHome, 'config.json'), '{ broken');
const seenPids = new Set();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// runOnStand кончается process.exit — уборка ядра надзора только в `exit`.
process.once('exit', () => {
  for (const pid of seenPids) if (alive(pid)) killProcessTree(pid);
  try {
    rmSync(coreHome, { recursive: true, force: true });
  } catch {
    // каталог держит снимаемое ядро — временный каталог ОС, не дом человека
  }
});

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`), fullPage: true });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

await runOnStand(
  {
    label: 'core-fault',
    core: false,
    env: { AGENTDECK_CORE_SUPERVISE: '1', AGENTDECK_CORE_HOME: coreHome },
  },
  async (stand, check) => {
    const status = async () => (await stand.api('/core/supervisor')).body;
    let last = null;
    // Отступ 1+2+4+8 с между пятью падениями — меньше минуты; запас на холодный старт ядра.
    for (let i = 0; i < 360; i += 1) {
      last = await status().catch(() => null);
      if (last?.pid) seenPids.add(last.pid);
      if (last?.state === 'fault') break;
      await wait(500);
    }
    check(
      'настройка сломана — надзор сдался: fault, 5 падений',
      last?.state === 'fault' && last.restarts >= 5,
      JSON.stringify(last),
    );
    check(
      'хвост журнала несёт причину падения',
      Array.isArray(last?.logTail) &&
        last.logTail.some((l) => l.includes('core config unreadable')),
      JSON.stringify(last?.logTail),
    );
    // Код выхода ядро пишет само (`core.exit.json`): на Windows ядро не ребёнок панели.
    check(
      'надзор знает код выхода упавшего ядра: 1',
      last?.lastExit?.code === 1,
      JSON.stringify(last?.lastExit),
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/core`);
      const card = page.locator('[data-core-fault-view="fault"]');
      await card.waitFor({ timeout: 30_000 });
      const text = await card.innerText();
      check('раздел /core: карточка сбоя «не запускается»', text.includes('не запускается'), text);
      check('на карточке нет «pnpm core»', !text.includes('pnpm core'), text);
      check('на карточке код выхода «код 1»', text.includes('Последний выход: код 1'), text);
      const log = await page.locator('[data-core-fault-log]').innerText();
      check(
        'хвост журнала ядра на карточке',
        log.includes('core config unreadable'),
        log.slice(0, 400),
      );
      const restart = page.locator('[data-core-fault-restart]');
      check('кнопка «Перезапустить»', (await restart.count()) === 1);
      await shoot(page, 'core-tasks-fault');

      // Починили настройку — «Перезапустить» поднимает ядро, раздел оживает сам.
      writeFileSync(
        join(coreHome, 'config.json'),
        `${JSON.stringify({ routes: { stub: DEFAULT_CORE_STUBS } }, null, 2)}\n`,
      );
      await restart.click();
      await page.getByText('Задач пока нет').waitFor({ timeout: 60_000 });
      const after = await status();
      if (after?.pid) seenPids.add(after.pid);
      check(
        '«Перезапустить» после починки — ядро поднято, список задач на месте',
        after?.state === 'up' && (await page.locator('[data-core-refusal]').count()) === 0,
        JSON.stringify(after),
      );
      await shoot(page, 'core-tasks-recovered');
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
