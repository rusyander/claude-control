/**
 * Открытая вкладка чата следует за состоянием ПАНЕЛИ, изменённым в другой
 * вкладке или с другого клиента, — без перезагрузки.
 *
 * Было (WA 28.09, «Observation»): поток событий `/api/events` нёс только
 * изменения ФАЙЛОВ конфигурации; собственное состояние панели (настройки,
 * группы, выбор группы у чата и у проекта — `state.json`, `group-sources.json`)
 * на нём не появлялось. Меню «Группа» открытого чата держало прежнюю подпись, а
 * язык, сменённый в соседней вкладке, не доходил до этой до F5.
 *
 * Путь настоящий: одноразовая панель над временным домом, настоящий Vite,
 * фальшивый `claude` на PATH (меню группы есть только у чата после первого
 * хода). Две вкладки — две страницы ОДНОГО контекста браузера, как у человека:
 * общий localStorage, у каждой свой поток событий.
 *
 *   1. вкладка B выбирает группу в меню того же чата → меню вкладки A называет её;
 *   2. закреплённую группу удалили с другого клиента (API, как телефон) → меню A
 *      говорит «Нет в списке»;
 *   3. вкладка B переключает язык в «Настройках» → вкладка A по-английски; и обратно.
 *
 * Запуск: `node tools/qa/check-live-app-state.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chatGroupMenu, openProjectChat, sendAndWait } from './chat-walk.mjs';
import { FAKE_APPEND_CLI } from './fake-cli-append.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SKILL = ['---', 'name: live-skill', 'description: A skill.', '---', '', 'Do it.', ''].join(
  '\n',
);

/** Ждать условия до `seconds`; вернуть последнее значение. */
async function until(read, test, seconds = 12) {
  let last = await read();
  for (let i = 0; i < seconds * 4 && !test(last); i += 1) {
    await wait(250);
    last = await read();
  }
  return last;
}

/**
 * Подпись меню «Группа», за которой следят при ОТКРЫТОМ меню: переоткрытие
 * монтировало бы запросы заново, и устаревший кеш перечитался бы сам — без
 * всякого события. Открытое меню меняется только тем, что пришло в кеш.
 */
async function watchMenu(page, test, seconds = 8) {
  await page.getByRole('button', { name: 'Настройки чата' }).first().click();
  const select = page.getByRole('combobox', { name: 'Группа' });
  await select.waitFor({ timeout: 10_000 });
  const label = () =>
    select.evaluate((node) =>
      node instanceof HTMLSelectElement ? (node.selectedOptions[0]?.textContent ?? '').trim() : '',
    );
  const last = await until(label, test, seconds);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `menu-${Date.now()}.png`) });
  await page.keyboard.press('Escape');
  await wait(300);
  return last;
}

await runOnStand(
  {
    label: 'live-app-state',
    fakeCli: { claude: FAKE_APPEND_CLI },
    seed: ({ home, cfg }) => {
      mkdirSync(join(cfg, 'skills', 'live-skill'), { recursive: true });
      writeFileSync(join(cfg, 'skills', 'live-skill', 'SKILL.md'), SKILL, 'utf8');
      mkdirSync(join(home, 'repo'), { recursive: true });
      writeFileSync(join(home, 'repo', 'a.txt'), 'x\n', 'utf8');
    },
  },
  async (stand, check) => {
    const repo = join(stand.home, 'repo');
    await stand.api('/projects', { method: 'POST', body: { path: repo } });
    const ids = {};
    for (const name of ['Alpha', 'Beta']) {
      const made = await stand.api('/groups', {
        method: 'POST',
        body: { name, members: [{ kind: 'skill', id: 'live-skill' }] },
      });
      check(
        `группа ${name} создана`,
        made.status === 200,
        `${made.status} ${made.text.slice(0, 200)}`,
      );
      ids[name] = made.body?.id;
    }

    const browser = await chromium.launch();
    try {
      // Один контекст — две вкладки одного браузера.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const tabs = { newPage: () => context.newPage() };
      const a = await openProjectChat(stand, tabs, repo, 'repo');
      check(
        'вкладка A: первый ход дошёл до CLI',
        Boolean(await sendAndWait(a, stand, 'live warm up')),
      );
      // Вторая вкладка открывает тот же чат: рабочее пространство — общее.
      const b = await context.newPage();
      b.errors = [];
      b.on('pageerror', (error) => b.errors.push(error.message));
      await b.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
      await b.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await a.evaluate(() => {
        window.__sameDocument = true;
      });

      // Выбор в A — сразу перед шагом 1: кеш меню A свеж (staleTime 30 с), и
      // перечитать его при открытии меню он сам не может — только по событию.
      const picked = await chatGroupMenu(a, /^Alpha/);
      check(
        'вкладка A: в меню выбрана Alpha',
        /^Alpha/.test((await chatGroupMenu(a)).current),
        picked.current,
      );

      // 1. B выбирает Beta — A следует без перезагрузки.
      // Меню A открыто ДО выбора в B и не закрывается, пока ждём.
      const followedP = watchMenu(a, (label) => /^Beta/.test(label));
      await wait(1500);
      await chatGroupMenu(b, /^Beta/);
      const followed = await followedP;
      check(
        '1. выбор группы во вкладке B виден во вкладке A без перезагрузки',
        /^Beta/.test(followed),
        `A: «${followed}»`,
      );

      // 2. Beta удалили с другого клиента — меню A не держит её как живую.
      const goneP = watchMenu(a, (label) => /Нет в списке/.test(label));
      await wait(1500);
      const removed = await stand.api(`/groups/${ids.Beta}`, { method: 'DELETE' });
      check('Beta удалена через API', removed.status < 300, `${removed.status}`);
      const gone = await goneP;
      check(
        '2. удалённая группа во вкладке A — «Нет в списке» без перезагрузки',
        /Нет в списке/.test(gone),
        `A: «${gone}»`,
      );

      // 3. B меняет язык в «Настройках» — A переходит на английский.
      await b
        .getByRole('link', { name: /^Настройки/ })
        .first()
        .click();
      await b.getByRole('button', { name: 'English', exact: true }).click();
      const langA = () =>
        a.evaluate(() => ({
          lang: document.documentElement.lang,
          nav: [...document.querySelectorAll('nav a')]
            .map((link) => link.textContent ?? '')
            .join('|'),
        }));
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
        'вкладка A ни разу не перезагружалась',
        await a.evaluate(() => window.__sameDocument === true),
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
