/**
 * Ноги доски сквозного обхода волны 3 (`check-core-w3-cross-zone-live.mjs`):
 *   - связанные карточки из `packages/stub-tracker` (17 историй одного эпика) → окно записи:
 *     отмечено не больше 15, предел назван; гонка двух страниц: отказ объединения и отказ хода —
 *     по-русски, без прозы ядра; принятое объединение → одна запись → одна задача со всеми тикетами;
 *   - «Максимум качества»: задача ведущего доходит до второго ревью, и оно идёт на другом CLI (codex).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { coreDirect, uuidv7 } from './core-scenario-stand.mjs';
import { shoot, until } from './core-w3-walk-legs.mjs';

const ENGLISH = /only inbox entries|is queued|not allowed|entry [0-9a-f-]{8}|move \w+ from/i;
/** Перечитка доски страницей (GET `/api/core/board`), не её записи и не ходы. */
const BOARD_GET = /\/api\/core\/board(\?.*)?$/;
/** Ход карточки и объединение (`POST /api/core/board/move`). */
const BOARD_MOVE = /\/api\/core\/board\/move/;

const entryOf = (board, key) =>
  (board?.entries ?? []).find(
    (e) => e.source?.key === key || JSON.stringify(e.source).includes(`"${key}"`),
  );

async function openEntry(stand, page, entryId) {
  await page.goto(`${stand.webUrl}/core?view=board`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-core-board]').waitFor({ timeout: 120_000 });
  const tile = page.locator(`[data-board-card="${entryId}"]`).first();
  await tile.waitFor({ timeout: 30_000 });
  await tile.click();
  const modal = page.locator(`[data-card-modal="${entryId}"]`);
  await modal.waitFor({ timeout: 15_000 });
  return modal;
}

// ── связанные карточки → объединение → одна задача ──────────────────────────────────────────────

export async function walkRelated(ctx, browser) {
  const { stand, check } = ctx;
  const board = () => stand.api('/core/board').then((r) => r.body);
  const all = await until(
    async () => {
      const b = await board();
      const keys = Array.from({ length: 17 }, (_, i) => `PROJ-${101 + i}`);
      return keys.every((k) => entryOf(b, k)) ? b : null;
    },
    150,
    2000,
  );
  if (!check('опрос трекера положил во «Входящие» 17 историй эпика', Boolean(all))) {
    const b = await board();
    console.log(JSON.stringify(b?.entries?.map((e) => e.source)).slice(0, 800));
    return;
  }
  const lead = entryOf(all, 'PROJ-101');
  check(
    `запись PROJ-101 знает связанные (${lead.related?.length ?? 0})`,
    (lead.related?.length ?? 0) >= 16 ||
      (all.cards ?? []).some((c) => (c.related?.length ?? 0) >= 16),
    JSON.stringify(lead).slice(0, 500),
  );
  const pageA = await stand.newPage(browser, { width: 1500, height: 1600 });
  const pageB = await stand.newPage(browser, { width: 1500, height: 1600 });
  try {
    const modal = await openEntry(stand, pageA, lead.entryId);
    const section = modal.locator('[data-related-merge]');
    await section.waitFor({ timeout: 15_000 });
    const boxes = section.locator('[data-related-item] input[type="checkbox"]');
    const total = await boxes.count();
    const checked = await boxes.evaluateAll((list) => list.filter((b) => b.checked).length);
    const lockedUnchecked = await boxes.evaluateAll(
      (list) => list.filter((b) => !b.checked && b.disabled).length,
    );
    const cap = (
      await section
        .locator('[data-related-merge-cap]')
        .innerText()
        .catch(() => '')
    ).trim();
    check(
      `предел объединения: связанных ${total}, отмечено ${checked}, лишние заперты (${lockedUnchecked}), предел назван`,
      total === 16 && checked === 15 && lockedUnchecked === 1 && cap.includes('не больше 16'),
      cap,
    );
    await shoot(ctx, pageA, 'related-cap');
    // Гонке нужны записи, ОТМЕЧЕННЫЕ в окне: шестнадцатая связанная заперта без отметки, и её уход в
    // очередь объединению не мешает. Порядок связанных — решение панели, берём из окна.
    const checkedIds = await boxes.evaluateAll((list) =>
      list
        .filter((b) => b.checked)
        .map((b) => b.closest('[data-related-item]')?.getAttribute('data-related-item') ?? ''),
    );
    const byId = (id) => (all.entries ?? []).find((e) => e.entryId === id);
    const second = byId(checkedIds[0]);
    const third = byId(checkedIds[1]);
    if (
      !check(
        'в окне две отмеченные связанные для гонки',
        Boolean(second && third),
        checkedIds.join(', '),
      )
    )
      return;
    const secondKey = second.source.key;
    const thirdKey = third.source.key;

    // Гонка: вторая страница уводит отмеченную запись в очередь, первая тут же объединяет со старой отметкой.
    // Перечитка доски первой страницы (каждые 5 с) придержана до хода: иначе она успевает снять
    // её отметку раньше клика, и гонки нет — это тайминг стенда, а не поведение панели.
    // Маршрут ставится один раз, придержка — флагом: снятие маршрута (`unroute`) асинхронно, и
    // перечитка, пойманная уже после сброса придержанных, висела бы вечно вместе с ходом.
    const held = [];
    let heldTotal = 0;
    let holding = false;
    const hold = (route) => {
      if (!holding) return route.continue().catch(() => undefined);
      heldTotal += 1;
      held.push(route);
      return undefined;
    };
    const release = async () => {
      holding = false;
      for (const route of held.splice(0)) await route.continue().catch(() => undefined);
    };
    // Ответ объединения страницы A — в разбор провала: принят, отказан или не ушёл вовсе.
    const mergeReplies = [];
    const onReply = async (res) => {
      if (!BOARD_MOVE.test(res.url())) return;
      const sent = res.request().postData() ?? '';
      const body = await res.text().catch(() => '');
      mergeReplies.push(`${res.status()} ${sent.slice(0, 400)} → ${body.slice(0, 300)}`);
    };
    pageA.on('response', onReply);
    await pageA.route(BOARD_GET, hold);
    holding = true;
    // Ход страницы A ушёл с устаревшей отметкой и ответ получен — придержку снять сразу: исход хода
    // панель ждёт вместе с перечиткой доски (`onSettled`), придержанная перечитка держала бы его.
    const clickAndRelease = async (page, target) => {
      const replied = page
        .waitForResponse((r) => BOARD_MOVE.test(r.url()), { timeout: 15_000 })
        .catch(() => null);
      await target.click();
      const reply = await replied;
      await release();
      return reply ? { status: reply.status(), body: await reply.json().catch(() => null) } : null;
    };
    const modalB = await openEntry(stand, pageB, second.entryId);
    await modalB.locator('[data-card-move="queue"]').click();
    await until(async () => entryOf(await board(), secondKey)?.state === 'queued', 20, 300);
    await clickAndRelease(pageA, section.locator('[data-related-merge-submit]'));
    const refused = section.locator('[data-related-merge-refused]');
    await refused.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const refusedText = (await refused.innerText().catch(() => '')).trim();
    if (refusedText) {
      check(
        'отказ объединения — по-русски, с тикетом, без прозы ядра на экране',
        refusedText.includes(secondKey) &&
          refusedText.includes('уже не во «Входящих»') &&
          !ENGLISH.test(refusedText),
        refusedText,
      );
      await shoot(ctx, pageA, 'related-refused');
    } else {
      check(
        'отказ объединения увиден (доска страницы перечиталась раньше хода — гонка не случилась)',
        false,
        `придержано перечиток ${heldTotal}; ответы хода: ${mergeReplies.join(' | ') || 'нет'}; ` +
          (await section.innerText().catch(() => '')).slice(-400),
      );
      await shoot(ctx, pageA, 'related-no-refusal');
    }

    // Отказ хода карточки: обе страницы держат окно третьей записи, вторая отклоняет её, первая
    // ставит в очередь со старого окна. Суд ядра — отказ 409, запись осталась отклонённой; окно A
    // после перечитки доски (отклонённой записи на ней уже нет) остаётся открытым на той же записи и
    // показывает отказ, а не закрывается молча. Та же придержка перечитки страницы A: иначе её окно
    // успевает убрать ход «В очередь».
    const modalA3 = await openEntry(stand, pageA, third.entryId);
    holding = true;
    const modalB3 = await openEntry(stand, pageB, third.entryId);
    await modalB3.locator('[data-card-move="rejected"]').click();
    await until(async () => entryOf(await board(), thirdKey)?.state === 'rejected', 20, 300);
    const moveReply = await clickAndRelease(pageA, modalA3.locator('[data-card-move="queue"]'));
    const thirdAfter = entryOf(await board(), thirdKey);
    check(
      'ход со старого окна (гонка двух страниц) — ядро отказало 409, запись осталась отклонённой',
      moveReply?.status === 409 &&
        moveReply.body?.code === 'move-not-allowed' &&
        thirdAfter?.state === 'rejected',
      `${JSON.stringify(moveReply).slice(0, 300)}; состояние ${thirdAfter?.state}`,
    );
    // Перечитка доски страницы A после отказа уже прошла (её ждёт сам ход) — дать ей отрисоваться.
    await until(
      async () =>
        (await pageA.locator(`[data-card-modal="${third.entryId}"]`).count()) === 0 || null,
      6,
      300,
    );
    const windowA = pageA.locator(`[data-card-modal="${third.entryId}"]`);
    const stillOpen = (await windowA.count()) === 1;
    const refusalText = stillOpen
      ? (
          await windowA
            .locator('[data-card-move-reason]')
            .innerText()
            .catch(() => '')
        ).trim()
      : '';
    const staleNote = stillOpen ? await windowA.locator('[data-card-stale]').count() : 0;
    check(
      'отказ хода со старого окна виден: окно A осталось на той же записи, причина по-русски, пометка «карточка уже изменилась»',
      stillOpen &&
        refusalText.includes('Ход не принят') &&
        !ENGLISH.test(refusalText) &&
        staleNote === 1,
      `окно открыто: ${stillOpen}; отказ: «${refusalText}»; пометка: ${staleNote}; окна на странице: ${await pageA
        .locator('[data-card-modal]')
        .evaluateAll((list) => list.map((m) => m.getAttribute('data-card-modal')).join(','))}`,
    );
    await shoot(ctx, pageA, 'card-move-refused');

    // Принятое объединение: окно перечитано, ушедшая в работу и отклонённая — не в связанных, отмечены все 14.
    const modal2 = await openEntry(stand, pageA, lead.entryId);
    const section2 = modal2.locator('[data-related-merge]');
    await section2.waitFor({ timeout: 15_000 });
    const picked = await section2
      .locator('[data-related-item] input[type="checkbox"]')
      .evaluateAll((list) => list.filter((b) => b.checked).length);
    await section2.locator('[data-related-merge-submit]').click();
    const merged = await until(async () => {
      const e = entryOf(await board(), 'PROJ-101');
      return (e?.merged?.length ?? 0) >= 1 ? e : null;
    }, 30);
    check(
      `объединение принято: на записи PROJ-101 ${merged?.merged?.length ?? 0} тикетов сверх своего (отмечено ${picked})`,
      Boolean(merged) && merged.merged.length === picked && picked === 14,
      JSON.stringify(merged?.merged?.map((s) => s.key)),
    );
    // Запись — в очередь; доска стартует ОДНУ задачу со всеми тикетами.
    const modal3 = await openEntry(stand, pageA, lead.entryId);
    await modal3.locator('[data-card-move="queue"]').click();
    const startedEntry = await until(
      async () => {
        const e = entryOf(await board(), 'PROJ-101');
        return e?.taskId ? e : null;
      },
      120,
      1000,
    );
    const taskId = startedEntry?.taskId;
    if (taskId) ctx.tasks.add(taskId);
    const journal = taskId ? journalText(stand.coreHome, taskId) : '';
    const keys = ['PROJ-101', ...(merged?.merged ?? []).map((s) => s.key)];
    check(
      `одна задача со всеми ${keys.length} тикетами`,
      Boolean(taskId) && keys.every((k) => journal.includes(k)),
      `${taskId}: нет ${keys.filter((k) => !journal.includes(k)).join(', ')}`,
    );
    check(
      'страницы доски без ошибок',
      pageA.errors.length === 0 && pageB.errors.length === 0,
      [...pageA.errors, ...pageB.errors].join(' | '),
    );
  } finally {
    await pageA.close();
    await pageB.close();
  }
}

/** Журнал задачи ядра целиком (поиск по тексту). */
export function journalText(coreHome, taskId) {
  const dir = join(coreHome, 'tasks', taskId);
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

const linesOf = (coreHome, taskId) =>
  journalText(coreHome, taskId)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ── «Максимум качества» → второе ревью на другом CLI ───────────────────────────────────────────

export async function walkStrict(ctx) {
  const { stand, check, paths } = ctx;
  if (!ctx.codex) {
    check('codex в PATH для второго ревью', false, 'codex не найден — второе ревью не проверено');
    return;
  }
  const core = coreDirect(stand);
  const view = await core.direct('GET', '/v1/config');
  const doc = { ...view.body.doc, lead: { defaults: { profile: 'max-quality' } } };
  const saved = await core.direct('POST', '/v1/config', {
    cmdId: uuidv7(),
    doc,
    baseDigest: view.body.digest,
    proof: await core.proof(),
  });
  check(
    'профиль ведения «Максимум качества» записан',
    saved.status === 200,
    saved.text.slice(0, 300),
  );
  const est = await core.direct('POST', '/v1/estimate', {
    cmdId: uuidv7(),
    fields: {
      title: 'W3 строгий профиль',
      request: 'Write hello.txt with one line.',
      repos: [{ path: paths.p1, baseRef: null }],
      scenario: { preset: 'lead' },
      launchPolicy: 'confirm',
      ciWait: false,
    },
    proof: await core.proof(),
  });
  const taskId = est.body?.taskId;
  if (
    !check(
      'оценка создала задачу ведущего',
      Boolean(taskId),
      `${est.status} ${est.text.slice(0, 400)}`,
    )
  )
    return;
  ctx.tasks.add(taskId);
  ctx.strictTask = taskId;
  const command = async (kind, fields) =>
    core.direct('POST', '/v1/commands', {
      cmdId: uuidv7(),
      kind,
      target: { taskId },
      fields,
      proof: await core.proof(),
    });
  const route = await command('set-route', {
    scope: 'task',
    scopeId: taskId,
    allowedRoutes: ['claude', 'codex'].map((adapter) => ({
      adapter,
      route: { kind: 'stub', id: 'stub:stand' },
      modelPattern: '*',
    })),
  });
  const model = await command('set-model', {
    scope: 'task',
    scopeId: taskId,
    model: 'stub-model',
    effort: null,
    timing: 'now',
  });
  check(
    'маршрут-заглушка на claude и codex и модель задачи приняты',
    route.body?.status === 'applied' && model.body?.status === 'applied',
    `${route.text} ${model.text}`.slice(0, 400),
  );
  const answered = new Set();
  let last = '';
  const cross = await until(
    async () => {
      const v = (await stand.api(`/core/tasks/${encodeURIComponent(taskId)}`)).body?.view;
      for (const a of (v?.asks ?? []).filter((x) => x.state === 'open' && !answered.has(x.askId))) {
        answered.add(a.askId);
        if (a.source === 'launch' && String(a.dedupe ?? '').startsWith('split:'))
          await command('approve-split', { splitId: a.dedupe.slice('split:'.length) });
        else
          await command('answer', {
            askId: a.askId,
            answer: a.recommendation ?? a.options?.[0] ?? 'go',
          });
      }
      const lines = linesOf(stand.coreHome, taskId);
      // Шаг второго ревью — по id шага сценария в строке старта (`crossOf` строка не несёт).
      const crossSteps = new Set(
        lines
          .filter((l) => l.kind === 'step.started' && l.data?.stepDefId === 'review-cross')
          .map((l) => l.data?.stepId)
          .filter(Boolean),
      );
      const sessions = lines.filter((l) =>
        /session\.(started|opened|start)/.test(String(l.kind ?? l.type)),
      );
      const ended = lines
        .filter((l) => l.kind === 'step.ended' && crossSteps.has(l.data?.stepId))
        .map((l) => `${l.data?.outcome}: ${l.data?.reason}`);
      last = `${v?.state}; шаги ${lines
        .filter((l) => String(l.kind ?? l.type).startsWith('step.'))
        .map((l) => `${l.kind ?? l.type}:${l.data?.def?.id ?? l.data?.stepDefId ?? ''}`)
        .slice(-8)
        .join(', ')}; сессии ${sessions
        .map((s) => `${s.data?.adapter}@${crossSteps.has(s.data?.stepId) ? 'cross' : 'other'}`)
        .join(',')}; конец второго ревью ${ended.join(' | ') || 'нет'}`;
      const onCross = sessions.filter((s) => crossSteps.has(s.data?.stepId));
      if (onCross.length > 0) return { onCross, sessions };
      return v?.state === 'failed' || v?.state === 'cancelled' || v?.state === 'done'
        ? { onCross, sessions, ended: v.state }
        : null;
    },
    600,
    1500,
  );
  const reviewers = (cross?.sessions ?? []).map((s) => s.data?.adapter);
  check(
    `второе ревью «Максимума качества» шло на codex (сессии: ${reviewers.join(', ') || 'нет'})`,
    Boolean(cross?.onCross?.length) && cross.onCross.every((s) => s.data?.adapter === 'codex'),
    last,
  );
  check(
    'первое ревью и работа — на claude',
    (cross?.sessions ?? []).some((s) => s.data?.adapter === 'claude'),
    last,
  );
}
