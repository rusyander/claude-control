/**
 * Открытая вкладка чата следует за состоянием ПАНЕЛИ, изменённым в другой
 * вкладке или с другого клиента, — без перезагрузки.
 *
 * Было (WA 28.09, «Observation»): поток событий `/api/events` нёс только
 * изменения ФАЙЛОВ конфигурации; собственное состояние панели (`state.json`)
 * на нём не появлялось, и язык, сменённый в соседней вкладке, не доходил до
 * открытого чата до F5.
 *
 * Шагов про меню «Группа» больше нет (этап 10): группы только читаются
 * (`legacy-groups-routes`), меню группы в чате не монтируется, выбирать и
 * удалять там нечего — работу ведут сценарии ядра, а их выбор живёт в задаче
 * ядра, не в состоянии панели.
 *
 * Путь настоящий: одноразовая панель над временным домом с ядром, настоящий
 * Vite. Две вкладки — две страницы ОДНОГО контекста браузера, как у человека:
 * общий localStorage, у каждой свой поток событий. Ход в чат не нужен: язык
 * переключает оболочка открытой страницы, а не разговор.
 *
 *   3. вкладка B переключает язык в «Настройках» → открытый чат во вкладке A
 *      по-английски; и обратно — без перезагрузки A.
 *
 * Запуск: `node tools/qa/check-live-app-state.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openProjectChat } from './chat-walk.mjs';
import { FAKE_APPEND_CLI } from './fake-cli-append.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Ждать условия до `seconds`; вернуть последнее значение. */
async function until(read, test, seconds = 12) {
  let last = await read();
  for (let i = 0; i < seconds * 4 && !test(last); i += 1) {
    await wait(250);
    last = await read();
  }
  return last;
}

await runOnStand(
  {
    label: 'live-app-state',
    // `claude` на PATH: без него чат открывается окном «нужен доступ», а не полем ввода.
    fakeCli: { claude: FAKE_APPEND_CLI },
    // Чат Claude идёт через ядро (s10): страница чата та же, что у человека с ядром.
    core: true,
    seed: ({ home }) => {
      mkdirSync(join(home, 'repo'), { recursive: true });
      writeFileSync(join(home, 'repo', 'a.txt'), 'x\n', 'utf8');
    },
  },
  async (stand, check) => {
    const repo = join(stand.home, 'repo');
    await stand.api('/projects', { method: 'POST', body: { path: repo } });

    const browser = await chromium.launch();
    try {
      // Один контекст — две вкладки одного браузера.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const tabs = { newPage: () => context.newPage() };
      const a = await openProjectChat(stand, tabs, repo, 'repo');
      const chatOpen = async () => (await a.locator('textarea[data-chat-input]').count()) > 0;
      check('вкладка A: чат проекта открыт, поле ввода на экране', await chatOpen());
      const b = await context.newPage();
      b.errors = [];
      b.on('pageerror', (error) => b.errors.push(error.message));
      await b.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await b.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await a.evaluate(() => {
        window.__sameDocument = true;
      });

      const langA = () =>
        a.evaluate(() => ({
          lang: document.documentElement.lang,
          nav: [...document.querySelectorAll('nav a')]
            .map((link) => link.textContent ?? '')
            .join('|'),
        }));
      const start = await langA();
      check(
        'вкладка A до правки — по-русски',
        start.lang === 'ru' && /Настройки/.test(start.nav),
        JSON.stringify(start).slice(0, 300),
      );

      // 3. B меняет язык в «Настройках» — A переходит на английский.
      await b
        .getByRole('link', { name: /^Настройки/ })
        .first()
        .click();
      await b.getByRole('button', { name: 'English', exact: true }).click();
      const en = await until(langA, (seen) => seen.lang === 'en' && /Settings/.test(seen.nav));
      if (SHOTS) await a.screenshot({ path: join(SHOTS, '3-tab-a-after-b-english.png') });
      check(
        '3. язык из вкладки B: вкладка A по-английски без перезагрузки',
        en.lang === 'en' && /Settings/.test(en.nav),
        JSON.stringify(en).slice(0, 300),
      );
      await b.getByRole('button', { name: 'Русский', exact: true }).click();
      const ru = await until(langA, (seen) => seen.lang === 'ru' && /Настройки/.test(seen.nav));
      check(
        '3. и обратно на русский',
        ru.lang === 'ru' && /Настройки/.test(ru.nav),
        JSON.stringify(ru).slice(0, 300),
      );
      check(
        'вкладка A ни разу не перезагружалась, чат всё ещё открыт',
        (await a.evaluate(() => window.__sameDocument === true)) && (await chatOpen()),
      );
      check(
        'страницы без ошибок',
        a.errors.length === 0 && b.errors.length === 0,
        [...a.errors, ...b.errors].join(' | '),
      );
      await context.close();
    } finally {
      await browser.close();
    }
  },
);
