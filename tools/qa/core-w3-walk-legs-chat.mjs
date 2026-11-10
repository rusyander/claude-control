/**
 * Ноги чата и телефона сквозного обхода волны 3 (`check-core-w3-cross-zone-live.mjs`): окно сайта
 * в чате (выбор элемента → чип → сообщение модели несёт разметку) и push телефону — по одному на
 * каждый ждущий вопрос всех задач обхода, ни одного на неждущий.
 */
import { openProjectChat } from './chat-walk.mjs';
import { shoot, until, userWordsOf } from './core-w3-walk-legs.mjs';

// ── окно сайта в чате ───────────────────────────────────────────────────────────────────────────

export async function walkPick(ctx, browser) {
  const { stand, check, paths } = ctx;
  const site = paths.pickSite;
  const added = await stand.api('/projects', {
    method: 'POST',
    body: { path: site, name: 'pick' },
  });
  if (added.status >= 300) throw new Error(`проект сайта: ${added.text}`);
  const started = await stand.api('/project-runner/start', {
    method: 'POST',
    body: { path: site },
  });
  check('реестр запусков принял сайт', started.status === 200, started.text);
  try {
    const run = await until(async () => {
      const runs = (await stand.api('/project-runner')).body;
      const got = (Array.isArray(runs) ? runs : []).find(
        (r) => r.projectPath.toLowerCase() === site.toLowerCase(),
      );
      return got?.status === 'running' && got.url ? got : null;
    }, 45);
    if (!check('сайт запущен и назвал адрес', Boolean(run))) return;
    const page = await openProjectChat(stand, browser, site, 'pick');
    try {
      const strip = page.locator('[data-site-open]');
      await strip.waitFor({ timeout: 30_000 });
      await strip.click();
      const pane = page.locator('[data-site-preview]');
      await pane.waitFor({ timeout: 15_000 });
      const frame = page.frameLocator('[data-site-preview] iframe');
      await frame.locator('button.buy').nth(1).waitFor({ timeout: 20_000 });
      await pane.getByRole('button', { name: 'Выбрать элемент' }).click();
      await frame.locator('button.buy').nth(1).hover();
      await frame.locator('button.buy').nth(1).click();
      const chips = page.locator('[data-composer-chip]');
      check('выбор элемента дал чип в поле ввода', Boolean(await until(() => chips.count(), 10)));
      await shoot(ctx, page, 'pick-chip');
      const input = page.locator('textarea[data-chat-input]');
      await input.fill('ход-pick: поправь эту кнопку');
      await input.press('Enter');
      check(
        'ход с выбором закончился ответом модели',
        Boolean(await until(() => page.getByText('выбор принят').count(), 180)),
      );
      const said = userWordsOf(ctx).find((w) => w.includes('ход-pick')) ?? '';
      const html = said.split('```html\n')[1]?.split('\n```')[0] ?? '';
      // Разметка кнопки длиннее предела (длинный data-blob у образца) — сервер режет её до 4 КБ,
      // текст кнопки идёт полем «текст»; значение data-token маскировано.
      check(
        'сообщение модели несёт блок элемента с разметкой выбранной кнопки',
        said.includes('Элемент со страницы сайта') &&
          said.includes('- текст: Pay for the order') &&
          html.startsWith('<button class="buy"') &&
          html.includes('data-token="••••••"') &&
          html.length > 0 &&
          html.length <= 4096,
        // Начало хода — напоминания CLI и обёртка платформы: показать сам блок элемента или хвост.
        said.includes('Элемент со страницы сайта')
          ? said.slice(said.indexOf('Элемент со страницы сайта'), said.indexOf('Элемент') + 1200)
          : said.slice(-1200),
      );
      check('чип после отправки снят', (await chips.count()) === 0);
      check('страница чата сайта без ошибок', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await page.close();
    }
  } finally {
    await stand.api('/project-runner/stop', { method: 'POST', body: { path: site } });
  }
}

// ── push телефону ───────────────────────────────────────────────────────────────────────────────

export async function walkRelay(ctx) {
  const { stand, check, expo } = ctx;
  const list = (await stand.api('/core/tasks')).body?.tasks ?? [];
  const asks = [];
  for (const t of list) {
    const id = t.taskId ?? t.id;
    const v = (await stand.api(`/core/tasks/${encodeURIComponent(id)}`)).body?.view;
    for (const a of v?.asks ?? []) asks.push({ taskId: id, ...a });
  }
  const waiting = asks.filter((a) => a.defaultAction === null || a.defaultAction === undefined);
  const nonWaiting = asks.filter((a) => a.defaultAction !== null && a.defaultAction !== undefined);
  const openWaiting = waiting.filter((a) => a.state === 'open');
  // Ждущему открытому вопросу push приходит за секунды; даём каналу дойти.
  await until(() => openWaiting.every((a) => expo.pushesFor(a.askId).length > 0), 60);
  const counts = (items) => items.map((a) => `${a.source}:${expo.pushesFor(a.askId).length}`);
  check(
    `открытые ждущие вопросы — ровно по одному push (${openWaiting.length}: ${counts(openWaiting).join(', ')})`,
    openWaiting.length > 0 && openWaiting.every((a) => expo.pushesFor(a.askId).length === 1),
  );
  check(
    `закрытые ждущие вопросы — не больше одного push (${waiting.length - openWaiting.length})`,
    waiting.every((a) => expo.pushesFor(a.askId).length <= 1),
    counts(waiting).join(', '),
  );
  check(
    `неждущие вопросы — ни одного push (${nonWaiting.length}: ${counts(nonWaiting).join(', ')})`,
    nonWaiting.length > 0 && nonWaiting.every((a) => expo.pushesFor(a.askId).length === 0),
  );
  const known = new Set(asks.map((a) => a.askId));
  const strays = expo.received.filter((m) => m?.data?.askId && !known.has(m.data.askId));
  check(
    `каждый push называет вопрос одной из задач обхода (всего push ${expo.received.length})`,
    strays.length === 0,
    JSON.stringify(strays).slice(0, 400),
  );
  ctx.relayCounts = { asks: asks.length, waiting: waiting.length, pushes: expo.received.length };
}
