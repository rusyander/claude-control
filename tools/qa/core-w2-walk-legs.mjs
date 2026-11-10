/**
 * Ноги сквозного обхода волны 2 (`check-core-w2-cross-zone-live.mjs`): входящие ядра из трекера и
 * форжа через окно панели, обход конца MR, ответ в тикет, Telegram, «На доску» из «Тестов». Каждая
 * нога получает `ctx` стенда (стенд, `check`, заглушки, засев) и страницу; проверки — строками
 * `check`, исключение ноги ловит `leg()` обхода.
 */
import { join } from 'node:path';
import { wait } from './throwaway-stand.mjs';

export async function until(probe, ms = 30_000, step = 300) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

export const has = async (locator, timeout = 8_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

/**
 * Карточка вопроса с `needle` одним сообщением. Открытых вопросов несколько — бот шлёт сводку «Ждут
 * ответа: N», где у вопроса одна кнопка «N · ❓ Ответить» (варианты всех вопросов разом — стена);
 * нажатие выносит вопрос отдельным сообщением с его вариантами. Сводку нога проходит так же, как
 * человек: номер вопроса — по блоку сводки, нажатие — колбэком бота. Ответ `{card, viaDigest}`.
 */
export async function singleCard(ctx, needle, ms = 60_000) {
  const { tg } = ctx;
  const isDigest = (c) => tg.keyboardOf(c).some((b) => b.text.includes('❓ Ответить'));
  const withNeedle = () =>
    tg.sent().filter((c) => tg.textOf(c).includes(needle) && tg.keyboardOf(c).length > 0);
  const first = await until(() => withNeedle()[0], ms);
  if (!first || !isDigest(first)) return { card: first, viaDigest: false };
  const blocks = tg.textOf(first).split('——————');
  const index = blocks.findIndex((b) => b.includes(needle));
  const button = tg.keyboardOf(first).find((b) => b.text.startsWith(`${index + 1} · ❓ Ответить`));
  if (index < 0 || !button) return { card: undefined, viaDigest: true };
  const seen = new Set(withNeedle());
  ctx.press(first, button);
  const card = await until(() => withNeedle().find((c) => !seen.has(c) && !isDigest(c)), 30_000);
  return { card, viaDigest: true };
}

const board = async (ctx) => (await ctx.stand.api('/core/board')).body ?? {};
const entriesOf = async (ctx, pick) => ((await board(ctx)).entries ?? []).filter(pick);
const cardOf = async (ctx, id) => ((await board(ctx)).cards ?? []).find((c) => c.id === id);
const tracked = (key) => (e) => e.source?.key === key;

async function shoot(ctx, page, name) {
  if (!ctx.SHOTS) return;
  await page.screenshot({ path: join(ctx.SHOTS, `${name}.png`) }).catch(() => undefined);
}

async function openBoard(ctx, page) {
  await page.goto(`${ctx.stand.webUrl}/core`, { waitUntil: 'domcontentloaded' });
  return has(page.locator('[data-board-inbox]'), 60_000);
}

async function openCard(page, id) {
  await page.locator(`[data-board-card="${id}"]`).first().click();
  const modal = page.locator(`[data-card-modal="${id}"]`);
  return (await has(modal)) ? modal : null;
}

// ── 1. источники → опрос → строка → поиск → «Во входящие» → сценарий → очередь → старт ─────────

export async function walkInbox(ctx, page) {
  const { check, repo } = ctx;
  check('над доской строка «Входящие из трекера»', await openBoard(ctx, page));
  // Кнопки строки заперты, пока не пришла настройка ядра: холодный фронт под нагрузкой — дольше
  // десяти секунд клика по умолчанию.
  await page
    .locator('[data-board-inbox-open="sources"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  await page.locator('[data-board-inbox-open="sources"]').click();
  const dialog = page.locator('[data-inbox-sources]');
  const system = dialog.getByLabel('Система источника');
  await system.selectOption('jira');
  await dialog.locator('[data-inbox-add]').click();
  const jira = dialog.locator('[data-inbox-source-index="0"]');
  await jira.getByLabel('Метки', { exact: true }).fill('agentdeck');
  await jira.getByLabel('Репозитории').fill(`PROJ = ${repo}`);
  await system.selectOption('gitlab');
  await dialog.locator('[data-inbox-add]').click();
  const gitlab = dialog.locator('[data-inbox-source-index="1"]');
  await gitlab.getByRole('switch', { name: /Мои MR с открытыми обсуждениями/ }).click();
  await gitlab.getByLabel('Репозитории').fill(`acme/app = ${repo}`);
  await dialog.getByLabel('Опрос').selectOption('1');
  const commentBack = page.getByRole('switch', { name: 'Ответ в тикет' });
  check(
    '«Ответ в тикет» по умолчанию выключен',
    (await commentBack.getAttribute('aria-checked')) === 'false',
  );
  await commentBack.click();
  await shoot(ctx, page, 'w2-inbox-sources');
  await page.locator('[data-inbox-save]').click();
  const saved = await until(async () => {
    const doc = (await ctx.stand.api('/core/config')).body?.doc;
    return doc?.inbox?.sources?.length === 2 ? doc.inbox : null;
  });
  check(
    'источники записаны в настройку ядра: jira + gitlab, autoQueue false, commentBack true, опрос 1 мин',
    saved?.sources?.every((s) => s.autoQueue === false) &&
      saved?.commentBack === true &&
      saved?.pollMs === 60_000,
    JSON.stringify(saved)?.slice(0, 400),
  );
  check(
    'строка над доской — 2 источника',
    (await page.locator('[data-board-inbox]').getAttribute('data-board-inbox-sources')) === '2',
  );

  // Опрос: смена раздела `inbox` — опрос на ближайшем такте (30 с).
  const polled = await until(async () => {
    const got = await entriesOf(ctx, (e) => e.state === 'inbox');
    const keys = got.map((e) => e.source?.key);
    return keys.includes('PROJ-2') &&
      keys.includes('PROJ-4') &&
      got.some((e) => e.source?.kind === 'forge')
      ? got
      : null;
  }, 90_000);
  check(
    'опрос: во «Входящих» тикеты с меткой (PROJ-2, PROJ-4) и свой MR с открытым обсуждением',
    Boolean(polled),
    JSON.stringify((await board(ctx)).entries?.map((e) => [e.source, e.state, e.reason]))?.slice(
      0,
      600,
    ),
  );
  check(
    'тикет без метки (PROJ-5) и тикет ответа (PROJ-7) опрос не завёл',
    (await entriesOf(ctx, (e) => e.source?.key === 'PROJ-5')).length === 0 &&
      (await entriesOf(ctx, tracked('PROJ-7'))).length === 1,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  const inboxColumn = page.locator('[data-board-column="inbox"]');
  check(
    'колонка «Входящие» доски показывает записи опроса',
    (await has(inboxColumn.getByText('Login button does nothing'), 20_000)) &&
      (await has(inboxColumn.getByText('Export report as CSV'))),
  );
  await shoot(ctx, page, 'w2-inbox-polled');

  // Поиск по ключу и по словам.
  await page.locator('[data-board-inbox-open="search"]').click();
  const search = page.locator('[data-inbox-search]');
  await search.getByLabel('Запрос').fill('PROJ-5');
  await search.locator('[data-inbox-search-run]').click();
  check(
    'поиск по ключу PROJ-5 — ровно этот тикет',
    (await has(search.locator('[data-inbox-item="PROJ-5"]'), 20_000)) &&
      (await search.locator('[data-inbox-item]').count()) === 1,
    await search.textContent().catch(() => ''),
  );
  await search.getByLabel('Запрос').fill('reset email');
  await search.locator('[data-inbox-search-run]').click();
  await wait(1500);
  check(
    'поиск словами «reset email» находит PROJ-5',
    await has(search.locator('[data-inbox-item="PROJ-5"]'), 20_000),
    (await search.textContent().catch(() => ''))?.slice(0, 300),
  );
  await search.locator('[data-inbox-item="PROJ-5"] input[type="checkbox"]').check();
  await search.locator('[data-inbox-create]').click();
  check(
    '«Во входящие (1)» — ответ ядра «новых 1»',
    await has(
      search.locator('[data-inbox-outcome]').getByText('новых 1', { exact: false }),
      20_000,
    ),
  );
  await page.keyboard.press('Escape');
  const found = await until(async () => (await entriesOf(ctx, tracked('PROJ-5')))[0]);
  check('PROJ-5 во «Входящих» доски', found?.state === 'inbox', JSON.stringify(found));
  if (!found) return;

  // Сценарий записи до старта.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const modal = await openCard(page, found.entryId);
  const select = modal?.locator('[data-entry-preset] select');
  const options = select
    ? await select.locator('option').evaluateAll((os) => os.map((o) => o.value))
    : [];
  const target = found.preset === 'bug-fix' ? 'feature' : 'bug-fix';
  check(
    `у записи — выбор «Сценарий» (сейчас ${found.preset}), есть ${target}`,
    Boolean(select) && options.includes(target),
    JSON.stringify(options),
  );
  if (select && options.includes(target)) await select.selectOption(target);
  const preset = await until(async () => {
    const e = (await entriesOf(ctx, tracked('PROJ-5')))[0];
    return e?.preset === target ? e : null;
  });
  check(`смена сценария дошла до ядра (${target})`, Boolean(preset));
  await shoot(ctx, page, 'w2-entry-preset');

  // «В очередь» → запускатель стартует задачу.
  await modal?.locator('[data-card-move="queue"]').click();
  const started = await until(async () => {
    const e = (await entriesOf(ctx, tracked('PROJ-5')))[0];
    return e?.state === 'started' && e.taskId ? e : null;
  }, 60_000);
  const startedTask = started ? (await ctx.stand.api(`/core/tasks/${started.taskId}`)).status : 0;
  check(
    '«В очередь» — запускатель стартовал задачу записи PROJ-5',
    Boolean(started) && startedTask === 200,
    JSON.stringify((await entriesOf(ctx, tracked('PROJ-5')))[0]),
  );
  await page.keyboard.press('Escape');
}

// ── 2. свой MR с обсуждением → одна запись, одна задача ответа ─────────────────────────────────

export async function walkOwnMr(ctx, page) {
  const { check } = ctx;
  const mrKey = (e) => e.source?.kind === 'forge';
  const first = await entriesOf(ctx, mrKey);
  // Ещё один круг опроса (раз в минуту): запись не множится.
  await wait(75_000);
  const again = await entriesOf(ctx, mrKey);
  check(
    'свой MR с обсуждением: одна запись через два круга опроса',
    first.length === 1 && again.length === 1,
    JSON.stringify(again.map((e) => [e.source, e.state, e.preset])),
  );
  const entry = again[0];
  if (!entry) return;
  check(
    'запись MR идёт пресетом answer-reviewers',
    entry.preset === 'answer-reviewers',
    entry.preset,
  );
  await openBoard(ctx, page);
  const modal = await openCard(page, entry.entryId);
  await modal?.locator('[data-card-move="queue"]').click();
  // `starting` — запускатель ещё открывает ревью по ссылке; судим, когда запись встала: старт с
  // задачей или возврат во «Входящие» с причиной.
  const settled = await until(async () => {
    const e = (await entriesOf(ctx, (x) => x.entryId === entry.entryId))[0];
    if (e?.state === 'started' && e.taskId) return e;
    return e && e.state === 'inbox' && e.reason ? e : null;
  }, 90_000);
  const tasks = ((await ctx.stand.api('/core/tasks')).body?.tasks ?? []).filter(
    (t) => t.boardEntry?.entryId === entry.entryId || t.taskId === settled?.taskId,
  );
  check(
    '«В очередь» записи MR — ровно одна задача ответа ревьюерам',
    settled?.state === 'started' && tasks.length === 1,
    JSON.stringify({
      entry: settled ?? (await entriesOf(ctx, (x) => x.entryId === entry.entryId))[0],
      tasks: tasks.length,
    }),
  );
  await page.keyboard.press('Escape');
}

// ── 3. MR слит на форже → карточка «Влит» ─────────────────────────────────────────────────────

export async function walkSweep(ctx, page) {
  const { check, seeded, forge } = ctx;
  const before = await cardOf(ctx, seeded.sweep);
  check('задача с открытым MR — в колонке «MR»', before?.column === 'mr', JSON.stringify(before));
  forge.act('reviewer', { type: 'merge', mrIid: ctx.sweepIid });
  const merged = await until(async () => {
    const c = await cardOf(ctx, seeded.sweep);
    return c?.column === 'merged' ? c : null;
  }, 75_000);
  check(
    'MR слит на форже — обход ядра перевёл карточку в «Влит»',
    Boolean(merged),
    JSON.stringify(await cardOf(ctx, seeded.sweep)),
  );
  await openBoard(ctx, page);
  check(
    'на доске карточка стоит в колонке «Влит»',
    await has(
      page.locator(`[data-board-column="merged"] [data-board-card="${seeded.sweep}"]`),
      20_000,
    ),
  );
}

// ── 4. ответ в тикет: вопрос пункта 9, Telegram не отпускает, панель отпускает ─────────────────

export async function walkCommentBack(ctx, page) {
  const { check, seeded, tracker, tg } = ctx;
  const comments = () => tracker.state().issues.find((i) => i.key === 'PROJ-7')?.comments ?? [];
  const { card } = await singleCard(ctx, 'PROJ-7', 40_000);
  const labels = tg.keyboardOf(card).map((b) => b.text);
  check(
    'вопрос пункта 9 в Telegram: только «Не писать», остальное — в панели или с телефона',
    Boolean(card) &&
      labels.some((l) => l.includes('Не писать')) &&
      !labels.some((l) => l.includes('Разрешить')) &&
      tg.textOf(card).includes('Остальные варианты'),
    JSON.stringify({ text: tg.textOf(card).slice(0, 300), labels }),
  );
  check('до ответа человека в тикете комментария нет', comments().length === 0);
  await openBoard(ctx, page);
  const modal = await openCard(page, seeded.comment);
  const ask = modal?.locator('[data-core-ask][data-ask-source="tracker-write"]');
  check(
    'окно карточки: вопрос с пометкой источника «запись в тикет»',
    Boolean(ask) && (await has(ask.getByText('запись в тикет', { exact: false }))),
    await ask?.textContent().catch(() => ''),
  );
  if (ctx.SHOTS) {
    await ask
      ?.screenshot({ path: join(ctx.SHOTS, 'w2-ask-source-badge-light.png') })
      .catch(() => undefined);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await ask
      ?.screenshot({ path: join(ctx.SHOTS, 'w2-ask-source-badge-dark.png') })
      .catch(() => undefined);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }
  await ask?.locator('[data-ask-option="Разрешить комментарий"]').click();
  const posted = await until(() => (comments().length > 0 ? comments() : null), 45_000);
  await wait(8_000);
  check(
    'ответ из панели отпустил запись: в тикете ровно один комментарий со ссылкой на MR',
    Boolean(posted) && comments().length === 1 && comments()[0].text.includes('merge_requests/70'),
    JSON.stringify(comments().map((c) => c.text)),
  );
  await page.keyboard.press('Escape');
}

// ── 5. «На доску» из «Тестов»: запись, после перезагрузки второй нет ─────────────────────────────

export async function walkTestsToBoard(ctx, browser) {
  const { check, stand } = ctx;
  const { installTestsRunStub, TESTS_PROJECT } = await import('./check-core-inbox.mjs');
  const page = await stand.newPage(browser, { width: 1600, height: 1000 });
  await installTestsRunStub(page);
  await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((project) => {
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    );
    localStorage.setItem('agentdeck:tests-project', project.path.toLowerCase());
  }, TESTS_PROJECT);
  const open = async () => {
    await page.goto(`${stand.webUrl}/tests?tab=runs`, { waitUntil: 'domcontentloaded' });
    const head = page.locator('[id^="run-card-"] button[aria-expanded]').first();
    if (await has(head, 30_000)) await head.click();
    return page.locator('[data-tests-to-board="gui:gui-001"]');
  };
  const red = await open();
  check('у красного кейса — «На доску»', await has(red));
  await red.click();
  const done = await has(
    page.locator('[data-tests-to-board="gui:gui-001"][data-tests-to-board-state="done"]'),
    20_000,
  );
  const fromTests = () =>
    entriesOf(ctx, (e) => e.source?.kind === 'tests' && e.source?.key === 'gui/gui-001');
  check(
    '«На доску» — запись во «Входящих» ядра, кнопка «На доске»',
    done && (await fromTests()).length === 1,
    JSON.stringify(await fromTests()),
  );
  const again = await open();
  await has(again);
  await wait(1500);
  check(
    'после перезагрузки — «На доске», нажать нельзя',
    (await page
      .locator('[data-tests-to-board="gui:gui-001"][data-tests-to-board-state="done"]')
      .count()) === 1 && (await again.isDisabled()),
  );
  await again.click({ force: true, timeout: 2000 }).catch(() => undefined);
  await wait(2000);
  check('второй записи на доске нет', (await fromTests()).length === 1);
  check('страница «Тестов» без ошибок', page.errors.length === 0, page.errors.join('; '));
  await page.close();
}
