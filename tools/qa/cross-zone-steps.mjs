/**
 * Шаги сквозного обхода ядра (`check-core-cross-zone-live.mjs`): доска, окно карточки с лимитом и
 * перехватом, чат перехвата с заметками к диффу, чат с карточкой лимита. Каждый шаг ведёт настоящий
 * экран панели; прямо в ядро идёт только подготовка (маршрут и модель задачи, раздел доски) и
 * запуск одиночной после разбора — то, что этот обход не судит.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GROUP_TITLE = 'Обход: группа из трёх';
const SINGLE_TITLE = 'Обход: одиночная задача';
const ITEMS = [
  { title: 'Пункт один', body: 'Создать one.txt со строкой one.' },
  { title: 'Пункт два', body: 'Создать two.txt со строкой two.' },
  { title: 'Пункт три', body: 'Создать three.txt со строкой three.' },
];
const STUB_ROUTE = { kind: 'stub', id: 'stub:stand' };
const LOGIN_ROUTE = { kind: 'cli-login', id: 'cli-login:claude' };

async function until(wait, what, probe, seconds, step = 1000) {
  for (let i = 0; i < (seconds * 1000) / step; i++) {
    const got = await probe();
    if (got) return got;
    await wait(step);
  }
  throw new Error(`не дождались: ${what}`);
}

async function shoot(ctx, page, name) {
  if (!ctx.SHOTS) return;
  mkdirSync(ctx.SHOTS, { recursive: true });
  await page.screenshot({ path: join(ctx.SHOTS, `cross-zone-${name}_AFTER.png`) });
}

function commandOf(ctx) {
  return async (taskId, kind, fields) =>
    ctx.core.direct('POST', '/v1/commands', {
      cmdId: ctx.uuidv7(),
      kind,
      target: { taskId },
      fields,
      proof: await ctx.core.proof(),
    });
}

/** Ответ ядра на команду, ушедшую с экрана по клику: `{kind, status, body}`. */
async function clickCommand(page, kind, click) {
  const answered = page.waitForResponse(
    (r) =>
      r.url().includes('/api/core/commands') &&
      r.request().method() === 'POST' &&
      (r.request().postData() ?? '').includes(`"kind":"${kind}"`),
    { timeout: 30_000 },
  );
  await click();
  const res = await answered.catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  return {
    status: body?.status ?? `http ${res?.status() ?? 'нет ответа'}`,
    sent: res ? JSON.parse(res.request().postData() ?? '{}') : null,
    body,
  };
}

// ── Доска: очередь, запуск, стадии, «Ждёт вас», шапка чата ─────────────────────────────────────

export async function walkBoard(ctx, page) {
  const { stand, check, wait } = ctx;
  const command = commandOf(ctx);
  const routed = new Set();
  /** Маршрут-заглушка группе; одиночной — вход CLI (модель stub-model) и заглушка (stub-alt). */
  const route = async (taskId, single) => {
    if (routed.has(taskId)) return;
    routed.add(taskId);
    const allowedRoutes = single
      ? [
          { adapter: 'claude', route: LOGIN_ROUTE, modelPattern: 'stub-model' },
          { adapter: 'claude', route: STUB_ROUTE, modelPattern: 'stub-alt' },
        ]
      : [{ adapter: 'claude', route: STUB_ROUTE, modelPattern: '*' }];
    const r = await command(taskId, 'set-route', { scope: 'task', scopeId: taskId, allowedRoutes });
    const m = await command(taskId, 'set-model', {
      scope: 'task',
      scopeId: taskId,
      model: 'stub-model',
      effort: null,
      timing: 'now',
    });
    if (r.body?.status !== 'applied' || m.body?.status !== 'applied')
      throw new Error(`маршрут/модель задачи ${taskId}: ${r.text} ${m.text}`);
  };
  const boardNow = async () => (await stand.api('/core/board')).body;
  const openBoard = async (search = 'view=board') => {
    await page.goto(`${stand.webUrl}/core?${search}`);
    await page.locator('[data-core-board]').waitFor({ timeout: 120_000 });
  };

  // «В очередь»: группа из трёх пунктов (приём ведущего), затем одиночная до плана.
  const form = page.locator('[data-core-launch-form]');
  const queue = async () => {
    const answered = page.waitForResponse((r) => r.url().includes('/api/core/board/entries'), {
      timeout: 60_000,
    });
    await page.locator('[data-queue-button]').click();
    const res = await answered.catch(() => null);
    return { status: res?.status() ?? 0, reply: res ? await res.json().catch(() => null) : null };
  };
  await page.goto(`${stand.webUrl}/core/launch`);
  await form.waitFor({ timeout: 120_000 });
  await form.getByLabel('Название', { exact: true }).fill(GROUP_TITLE);
  await form.getByLabel('Требования').fill('Создать три файла.');
  await form.getByLabel('Путь к репозиторию').fill(ctx.repo);
  await form.getByLabel('Сценарий').selectOption('preset:lead');
  await form.getByLabel('Источник').selectOption('items');
  for (const [i, item] of ITEMS.entries()) {
    if (i > 0) await form.getByRole('button', { name: 'Добавить пункт' }).click();
    await form.getByLabel(`Название пункта ${i + 1}`).fill(item.title);
    await form.getByLabel(`Текст пункта ${i + 1}`).fill(item.body);
  }
  await form.getByLabel('Как запустить пункты').selectOption('group');
  const group = await queue();
  const groupEntry = group.reply?.created?.[0];
  await page.goto(`${stand.webUrl}/core/launch`);
  await form.waitFor({ timeout: 60_000 });
  await form.getByLabel('Источник').selectOption('text');
  await form.getByLabel('Название', { exact: true }).fill(SINGLE_TITLE);
  await form.getByLabel('Требования').fill('Write hello.txt');
  await form.getByLabel('Путь к репозиторию').fill(ctx.repo);
  await form.getByLabel('Сценарий').selectOption('preset:bug-fix');
  await page.locator('[data-queue-stop] select').selectOption('plan');
  const single = await queue();
  const singleEntry = single.reply?.created?.[0];
  if (
    !check(
      `«В очередь»: группа (${group.status}) и одиночная (${single.status}) — две записи`,
      group.status === 200 && single.status === 200 && Boolean(groupEntry && singleEntry),
      `${JSON.stringify(group.reply)} ${JSON.stringify(single.reply)}`.slice(0, 600),
    )
  )
    return null;
  await openBoard();
  const queued = page.locator('[data-board-card-kind="entry"][data-board-card-column="queue"]');
  await until(wait, 'две записи в очереди', async () => (await queued.count()) === 2, 20).catch(
    () => undefined,
  );
  check(
    `на паузе обе записи в колонке «Очередь» (${await queued.count()})`,
    (await queued.count()) === 2,
  );
  await shoot(ctx, page, 'queue');

  // Запуск: пауза снята — группа ставит задачу на пункт, одиночная стартует, когда места свободны.
  const cfg = await ctx.core.direct('GET', '/v1/config');
  const unpaused = await ctx.core.direct('POST', '/v1/config', {
    cmdId: ctx.uuidv7(),
    doc: { ...cfg.body.doc, board: { ...cfg.body.doc.board, paused: false } },
    baseDigest: cfg.body.digest,
    proof: await ctx.core.proof(),
  });
  if (unpaused.status !== 200) throw new Error(`снятие паузы: ${unpaused.status} ${unpaused.text}`);
  const columns = [];
  let singleTask = '';
  let groupId = '';
  await until(
    wait,
    'группа и одиночная стартовали',
    async () => {
      const now = await boardNow();
      const cards = (now?.cards ?? []).filter((c) => c.kind === 'task');
      for (const c of cards) await route(c.taskId, c.entryId === singleEntry);
      const mine = cards.find((c) => c.entryId === singleEntry);
      if (mine) {
        singleTask = mine.taskId;
        if (columns.at(-1) !== mine.column) columns.push(mine.column);
      }
      const ofGroup = cards.filter((c) => c.entryId === groupEntry);
      groupId = ofGroup[0]?.groupId ?? '';
      return ofGroup.length === ITEMS.length && Boolean(singleTask);
    },
    300,
    250,
  );
  check(
    `запуск: задач группы ${ITEMS.length} под одним groupId (${groupId}), одиночная стартовала`,
    Boolean(groupId),
  );

  // Задачи группы ждут человека: чип доски и кнопка доски в шапке чата считают одно.
  await until(
    wait,
    'все задачи группы ждут вас',
    async () =>
      ((await boardNow())?.cards ?? []).filter((c) => c.entryId === groupEntry && c.waiting)
        .length === ITEMS.length,
    300,
  ).catch(() => undefined);
  await openBoard();
  const chip = page.locator('[data-board-waiting]');
  await chip.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const chipCount = Number(await chip.getAttribute('data-board-waiting').catch(() => '0'));
  const chat = await ctx.openProjectChat(stand, page.context().browser(), ctx.repo, 'repo');
  const headerButton = chat.locator('[data-chat-board]');
  await headerButton.waitFor({ timeout: 30_000 }).catch(() => undefined);
  // Число у кнопки появляется, когда пришёл ответ доски (до него кнопка без счёта).
  await until(
    wait,
    'счёт кнопки доски в шапке чата',
    async () => (await headerButton.getAttribute('data-board-waiting').catch(() => null)) !== null,
    30,
    250,
  ).catch(() => undefined);
  const headerCount = Number(
    (await headerButton.getAttribute('data-board-waiting').catch(() => null)) ?? '0',
  );
  check(
    `«Ждёт вас»: чип доски ${chipCount}, кнопка доски в шапке чата ${headerCount}`,
    chipCount >= ITEMS.length && headerCount === chipCount,
  );
  await chat.close();

  // Одиночная: разбор → запуск (подготовка, прямо в ядро) → работа упирается в окно.
  const viewOf = async () =>
    (await stand.api(`/core/tasks/${encodeURIComponent(singleTask)}`)).body?.view;
  const launchAsk = await until(
    wait,
    'вопрос запуска одиночной',
    async () => {
      const card = (await boardNow())?.cards.find((c) => c.taskId === singleTask);
      if (card && columns.at(-1) !== card.column) columns.push(card.column);
      return ((await viewOf())?.asks ?? []).find(
        (a) => a.state === 'open' && a.source === 'launch',
      );
    },
    300,
    500,
  );
  const approved = await command(singleTask, 'approve-split', {
    splitId: launchAsk.dedupe.slice('split:'.length),
  });
  if (approved.body?.status !== 'applied') throw new Error(`запуск одиночной: ${approved.text}`);
  const waiting = await until(
    wait,
    'одиночная ждёт окна',
    async () => {
      const card = (await boardNow())?.cards.find((c) => c.taskId === singleTask);
      if (card && columns.at(-1) !== card.column) columns.push(card.column);
      const view = await viewOf();
      return view?.windowWait ? { view, card } : null;
    },
    300,
    500,
  ).catch(() => null);
  check(
    `одиночная прошла колонками: ${columns.join(' → ')}; шаг работы упёрся в окно (${waiting?.view?.state ?? 'нет'}, ${waiting?.view?.windowWait?.routeId ?? '—'})`,
    columns[0] === 'triage' &&
      waiting?.view?.state === 'waiting-window' &&
      waiting.view.windowWait.routeId === LOGIN_ROUTE.id,
  );
  return { singleTask, groupId, groupEntry, columns, openBoard, boardNow, viewOf, waiting };
}

// ── Окно карточки: лимит, перехват, чат перехвата, возврат, доработка, полоса группы ────────────

export async function walkTakeover(ctx, page, board) {
  const { stand, check, wait } = ctx;
  const { singleTask, openBoard, viewOf } = board;
  const modal = page.locator(`[data-card-modal]`);
  const openCard = async () => {
    await openBoard();
    await page.locator('[data-board-card-kind="task"]', { hasText: SINGLE_TITLE }).first().click();
    await modal.waitFor({ timeout: 20_000 });
  };

  if (board.waiting) {
    await openCard();
    const limit = modal.locator('[data-limit-card]');
    await limit.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const offers = await modal
      .locator('[data-limit-offer]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-limit-offer')));
    check(
      `окно карточки: карточка лимита (${await limit.getAttribute('data-limit-verdict').catch(() => 'нет')}) с вариантами ${offers.join(', ') || 'нет'}`,
      (await limit.count()) === 1 && offers.includes('model:stub-alt'),
    );
    await shoot(ctx, page, 'window-card');
    if (offers.includes('model:stub-alt')) {
      const sent = await clickCommand(page, 'set-model', () =>
        modal.locator('[data-limit-offer="model:stub-alt"]').click(),
      );
      check(
        `клик «Другая модель: stub-alt» — команда set-model ${sent.sent?.fields?.model} (${sent.status})`,
        sent.status === 'applied' && sent.sent?.fields?.model === 'stub-alt',
        JSON.stringify(sent.body),
      );
      const moved = await until(
        wait,
        'одиночная пошла другим маршрутом',
        async () => {
          const v = await viewOf();
          // Живой шаг мало: шаг поднимается и падает на суде `compat`, если маршрут модели не
          // обслуживает. Нужен сеанс, открытый на заглушке с выбранной моделью.
          const onAlt = (v?.sessions ?? []).find(
            (s) => String(s.route?.id ?? s.route) === STUB_ROUTE.id && s.modelAsked === 'stub-alt',
          );
          return v?.state === 'running' && !v.windowWait && onAlt ? { v, onAlt } : null;
        },
        180,
      ).catch(() => null);
      check(
        `после клика задача идёт дальше: сеанс ${moved ? `${moved.onAlt.cli} на ${STUB_ROUTE.id}, модель ${moved.onAlt.modelAsked}` : 'на stub-alt не открылся'}, окна не ждёт`,
        Boolean(moved),
      );
    }
  }

  // Окно входа CLI сброшено — чат перехвата пойдёт этим входом.
  await wait(Math.max(0, ctx.world.windowUntil - Date.now()) + 5000);
  await openCard();
  const take = await clickCommand(page, 'take-over', () =>
    modal.locator('[data-takeover-open]').click(),
  );
  const chatTaskId = take.body?.outcome?.chatTaskId;
  check(
    `«Взять вручную» в окне карточки (${take.status})`,
    take.status === 'applied' && Boolean(chatTaskId),
    JSON.stringify(take.body),
  );
  if (!chatTaskId) return;
  const chatView = async () =>
    (await stand.api(`/core/tasks/${encodeURIComponent(chatTaskId)}`)).body?.view;
  const session = await until(
    wait,
    'сеанс чата перехвата',
    async () => (await chatView())?.sessions?.[0]?.sessionId,
    180,
  );
  await wait(6000);
  const link = modal.locator('[data-takeover-chat]');
  await link.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await link.click();
  await page.waitForURL(/\/chat(\?|$)/, { timeout: 60_000 });
  await ctx.dismissAccess(page);
  const landed = new URL(page.url()).searchParams.get('id');
  const ready = await until(
    wait,
    'слово чата перехвата',
    async () => (await page.locator('main').innerText()).includes('TAKEOVER-CHAT-READY'),
    60,
  ).catch(() => false);
  check(
    `«Открыть чат» → /chat?id=<сеанс перехвата> (${landed === session}), слово модели в ленте`,
    landed === session && ready === true,
  );
  const row = page.locator(`[data-chat-pin="${session}"]`);
  await row.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const view = async (id) => (await ctx.core.direct('GET', `/v1/tasks/${id}`)).body?.view;
  const steps = await ctx.stepSessionsOf(view, singleTask);
  const listed = new Set(((await stand.api('/chats')).body ?? []).map((c) => c.id));
  const leaked = steps.filter((s) => listed.has(s.id));
  check(
    `чат перехвата в боковом списке (строк ${await row.count()}); сеансов шагов задачи (${steps.map((s) => s.kind).join(', ')}) в списке ${leaked.length}`,
    (await row.count()) === 1 && steps.length > 0 && leaked.length === 0,
  );
  await shoot(ctx, page, 'takeover-chat');

  await diffNotes(ctx, page, take.body.outcome.copy ?? (await viewOf())?.takeover?.copy);

  // «Вернуть ядру» и «На доработку» — в окне карточки.
  await openCard();
  const back = await clickCommand(page, 'hand-back', () =>
    modal.locator('[data-takeover-handback]').click(),
  );
  const resumed = await until(
    wait,
    'задача снова идёт',
    async () => {
      const v = await viewOf();
      return v?.state === 'running' && !v.takeover ? v : null;
    },
    60,
  ).catch(() => null);
  const ended = await until(
    wait,
    'чат перехвата кончен',
    async () => (await chatView())?.ended,
    60,
  ).catch(() => null);
  check(
    `«Вернуть ядру» (${back.status}): задача ${resumed?.state ?? 'не идёт'}, чат перехвата ${ended ?? 'не кончен'}, разговор в списке ${((await stand.api('/chats')).body ?? []).some((c) => c.id === session)}`,
    back.status === 'applied' && Boolean(resumed) && Boolean(ended),
  );
  await page.keyboard.press('Escape');
  // Доработка идёт живому шагу: сразу после возврата задача ещё между шагами (ядро отказывает
  // `no live step`), поэтому сначала ждём, что ядро само подняло шаг прерванной работы.
  const liveAgain = await until(
    wait,
    'шаг после возврата',
    async () => (await viewOf())?.steps?.find((s) => s.state === 'running'),
    90,
  ).catch(() => null);
  check(
    `после возврата ядро подняло шаг сам: ${liveAgain ? `${liveAgain.stepKind} running` : 'шага нет за 90 с'}`,
    Boolean(liveAgain),
  );
  await openCard();
  const takeoverBox = modal.locator('[data-core-takeover="closed"]');
  await takeoverBox.locator('[data-takeover-rework]').waitFor({ timeout: 30_000 });
  await takeoverBox.locator('textarea').first().fill('ДОРАБОТКА-метка: добавь строку в hello.txt');
  const rework = await clickCommand(page, 'rework', () =>
    takeoverBox.locator('[data-takeover-rework]').click(),
  );
  check(
    `«На доработку» словами (${rework.status}): текст ушёл командой rework`,
    rework.status === 'applied' &&
      String(rework.sent?.fields?.text ?? '').includes('ДОРАБОТКА-метка'),
    JSON.stringify(rework.body),
  );
  await page.keyboard.press('Escape');

  // Полоса группы держит её три карточки.
  await openBoard(`view=board&lane=group`);
  const lane = page.locator(`[data-board-lane-group="${board.groupId}"]`);
  await lane.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const laneCards = await lane.locator('[data-board-card-kind="task"]').count();
  check(
    `полоса группы: ${await lane.getAttribute('data-board-lane-count').catch(() => '0')} по ответу, ${laneCards} на экране`,
    laneCards === ITEMS.length,
  );
  await shoot(ctx, page, 'group-lane');
}

/** Заметки к строке диффа в чате перехвата: правка человека в копии, «В очередь» и «Сейчас». */
async function diffNotes(ctx, page, copy) {
  const { check, wait } = ctx;
  if (!copy) {
    check('копия перехвата известна — заметки к диффу', false);
    return;
  }
  writeFileSync(
    join(copy, 'notes.txt'),
    'заметки человека\nстрока два\nстрока три\nправка человека один\nправка человека два\n',
  );
  const sends = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
    const body = req.postDataJSON?.() ?? {};
    sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? '') });
  });
  const input = page.locator('textarea[data-chat-input]');
  const dialog = page.getByRole('dialog');
  const tray = dialog.locator('[data-testid="diff-note"]');
  const busyTurn = async (mark) => {
    await input.fill(`ZANYAT ${mark}`);
    await input.press('Enter');
    await until(
      wait,
      `ход ${mark} у модели`,
      async () => ctx.world.said.some((s) => s.includes(mark)),
      90,
    );
  };
  // Холодный Vite стенда, встретив зависимость ленивого раздела окна кода впервые, доделывает
  // свои зависимости и перезагружает страницу (в консоли — повторное «[vite] connected»): открытое
  // окно пропадает вместе с ней. Это стенд, не продукт: перезагрузки считаются и называются в
  // итоге, а окно → файл → строка проходятся заново (до трёх раз).
  let reloads = 0;
  page.on('load', () => (reloads += 1));
  const noteOn = async (line, text) => {
    const file = dialog.getByRole('button', { name: /notes\.txt/ }).first();
    const row = dialog.locator(`[data-note-line="${line}"]`).first();
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      if ((await dialog.count()) === 0)
        await page.getByRole('button', { name: 'Код проекта' }).first().click();
      opened = await (async () => {
        await file.waitFor({ timeout: 20_000 });
        await file.click();
        await row.waitFor({ timeout: 20_000 });
        return true;
      })().catch(() => false);
      if (!opened) await ctx.dismissAccess(page);
    }
    if (!opened) {
      await shoot(ctx, page, `diff-note-failed-${line}`);
      throw new Error(
        `окно кода: строка ${line} notes.txt не открылась (перезагрузок страницы: ${reloads})`,
      );
    }
    await dialog.locator(`[data-note-line="${line}"]`).first().click();
    await dialog.locator('[data-testid="diff-note-draft"]').fill(text);
    await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  };
  const closeCode = async () => {
    await dialog.getByRole('button', { name: 'Закрыть' }).first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  };
  const withMark = (m) => sends.filter((s) => s.prompt.includes(m));

  await busyTurn('ход-q');
  await noteOn(4, 'метка-q строка человека');
  check(
    `заметка к строке диффа копии в лотке (${await tray.count()}; перезагрузок страницы стенда: ${reloads})`,
    (await tray.count()) === 1,
  );
  await shoot(ctx, page, 'diff-note');
  await dialog.getByRole('button', { name: 'В очередь', exact: true }).click();
  await wait(1500);
  const during = withMark('метка-q').length;
  await closeCode();
  const after = await until(
    wait,
    'заметка ушла после хода',
    async () => withMark('метка-q').length > 0,
    90,
  ).catch(() => false);
  check(
    `«В очередь» во время хода: пока ход идёт — ${during} отправок, после — ${withMark('метка-q').length}, не «на ходу»`,
    during === 0 &&
      after === true &&
      withMark('метка-q').length === 1 &&
      !withMark('метка-q')[0].steer,
  );
  await until(
    wait,
    'ход заметок отвечен',
    async () => (await page.getByText('заметки приняты').count()) > 0,
    90,
  ).catch(() => undefined);

  await busyTurn('ход-s');
  await noteOn(5, 'метка-s вторая строка человека');
  await dialog.getByRole('button', { name: 'Сейчас', exact: true }).click();
  await closeCode();
  await until(wait, '«Сейчас» ушла', async () => withMark('метка-s').length > 0, 30).catch(
    () => undefined,
  );
  const seen = await until(
    wait,
    'модель получила «Сейчас»',
    async () => ctx.world.said.some((s) => s.includes('метка-s')),
    120,
  ).catch(() => false);
  check(
    `«Сейчас» во время хода: один запрос «на ходу» (${withMark('метка-s')
      .map((s) => s.steer)
      .join(',')}), модель получила ${seen === true}`,
    withMark('метка-s').length === 1 && withMark('метка-s')[0].steer && seen === true,
  );
}

// ── Чат: карточка лимита и перенос ────────────────────────────────────────────────────────────

export async function walkChatLimit(ctx, browser) {
  const { stand, check, wait } = ctx;
  const page = await ctx.openProjectChat(stand, browser, ctx.repo, 'repo');
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await wait(1000);
  const input = page.locator('textarea[data-chat-input]');
  await input.fill('ход-L: привет');
  await input.press('Enter');
  const card = page.locator('[data-chat-limit]');
  const shown = await until(
    wait,
    'карточка лимита в чате',
    async () => (await card.count()) > 0,
    120,
  ).catch(() => false);
  const offers = shown
    ? await card
        .locator('[data-chat-limit-offer]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-limit-offer')))
    : [];
  check(
    `чат упёрся в окно — карточка лимита с вариантами ${offers.join(', ') || 'нет'}`,
    shown === true && offers.includes('cli:codex'),
  );
  if (!offers.includes('cli:codex')) return;
  await shoot(ctx, page, 'chat-limit');
  await card.getByRole('button', { name: /Перенести в codex/ }).click();
  const status = card.locator('[data-chat-limit-status]');
  await until(
    wait,
    'итог переноса',
    async () =>
      (await status.count()) > 0 &&
      (await status.first().getAttribute('data-chat-limit-status')) !== 'sending',
    60,
    250,
  ).catch(() => undefined);
  const state = (await status.count())
    ? await status.first().getAttribute('data-chat-limit-status')
    : '';
  check(
    `«Перенести в codex» перенёс разговор (${state})`,
    state === 'carried',
    (await status.count()) ? await status.first().innerText() : '',
  );
  check('страница чата без ошибок', page.errors.length === 0, page.errors.join('\n'));
  await page.close();
}
