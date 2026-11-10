/**
 * Ноги прохода по стенду сквозного обхода волны 3 (`check-core-w3-cross-zone-live.mjs`):
 * запись → прогон без модели → расхождение, переходы за пределы стендов и порты панели, проект в
 * подкаталоге репозитория, поиск значения доступа по всем файлам стенда. Каждая нога получает
 * общий `ctx` обхода (стенд, `check`, пути, сайты, след модели) и проверяет только свою дорогу.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './throwaway-stand.mjs';
import { sha256 } from './core-w3-walk-site.mjs';
import { userWords } from './core-w3-walk-model.mjs';

/** Опрос до правды или срока; ответ — последнее непустое значение пробы. */
export async function until(probe, seconds, stepMs = 500) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > end) return null;
    await wait(stepMs);
  }
}

/** Тела запросов модели обоих входов: заглушки CLI (память) и маршрута ядра (файл следа). */
export function modelBodies(ctx) {
  const out = [...ctx.cliTrace];
  const file = ctx.paths.coreTrace;
  if (file && existsSync(file))
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        out.push(row.request?.body ?? row.body ?? row);
      } catch {
        // Недописанная строка следа — следующая проба её прочтёт.
      }
    }
  return out;
}

/** Слова человека во всех телах запросов модели (без результатов инструментов). */
export function userWordsOf(ctx) {
  const out = [];
  for (const body of modelBodies(ctx)) out.push(...userWords(body));
  return out;
}

/** Результаты инструментов в телах запросов, где встречается метка цели: текст и признак ошибки. */
export function toolResults(ctx, marker) {
  const seen = new Map();
  for (const body of modelBodies(ctx)) {
    const text = JSON.stringify(body);
    if (!text.includes(marker)) continue;
    for (const m of Array.isArray(body?.messages) ? body.messages : []) {
      if (!Array.isArray(m?.content)) continue;
      for (const c of m.content) {
        if (c?.type !== 'tool_result') continue;
        const flat = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        seen.set(c.tool_use_id ?? flat, { text: flat, error: c.is_error === true });
      }
    }
  }
  return [...seen.values()];
}

const view = async (stand, taskId) =>
  (await stand.api(`/core/tasks/${encodeURIComponent(taskId)}`)).body?.view;
const walkOf = async (stand, taskId) =>
  (await stand.api(`/core/tasks/${encodeURIComponent(taskId)}/walk`)).body;

/** Проект в реестре панели, его окружения и доступы — как их заводит человек в «Тестах». */
export async function seedProject(ctx, { path, name, environments }) {
  const { stand } = ctx;
  const added = await stand.api('/projects', { method: 'POST', body: { path, name } });
  if (added.status >= 300) throw new Error(`проект ${name}: ${added.text}`);
  const ids = {};
  for (const env of environments) {
    const saved = await stand.api('/project-tests/environment', {
      method: 'POST',
      body: {
        path,
        environment: { title: env.title, baseUrl: env.baseUrl, isDefault: Boolean(env.isDefault) },
      },
    });
    if (saved.status >= 300) throw new Error(`окружение ${env.title}: ${saved.text}`);
    const found = (saved.body?.environments ?? []).find((e) => e.title === env.title);
    if (!found) throw new Error(`окружение ${env.title} не видно в ответе: ${saved.text}`);
    ids[env.title] = found.id;
    for (const name of env.secrets ?? []) {
      const secret = await stand.api('/project-tests/env-secret', {
        method: 'POST',
        body: { path, environmentId: found.id, name, title: name, value: ctx.SECRETS[name] },
      });
      if (secret.status >= 300) throw new Error(`доступ ${name}: ${secret.text}`);
    }
  }
  return ids;
}

/** Проход через ручку панели (та же, что жмёт окно) и ожидание его конца. */
async function walkViaApi(ctx, { path, goal, environmentId }) {
  const { stand } = ctx;
  const started = await stand.api('/project-tests/recorded/walk', {
    method: 'POST',
    body: { path, goal, environmentId },
  });
  const taskId = started.body?.taskId;
  if (!taskId) throw new Error(`проход «${goal}» не начался: ${started.status} ${started.text}`);
  ctx.tasks.add(taskId);
  let last = '';
  const walk = await until(
    async () => {
      const got = await walkOf(stand, taskId);
      const v = await view(stand, taskId);
      last = `${v?.state}; шагов ${got?.steps?.length ?? '?'}; вопросы ${(v?.asks ?? [])
        .filter((a) => a.state === 'open')
        .map((a) => `${a.source}: ${String(a.question ?? '').slice(0, 140)}`)
        .join(' | ')}`;
      return got?.ended ? got : null;
    },
    300,
    1000,
  );
  if (!walk) throw new Error(`проход «${goal}» не кончился за 5 мин (${last})`);
  return { taskId, walk, view: await view(stand, taskId) };
}

// ── 1. запись через окно ────────────────────────────────────────────────────────────────────────

export async function walkRecord(ctx, page) {
  const { stand, check, paths, site1 } = ctx;
  ctx.envP1 = await seedProject(ctx, {
    path: paths.p1,
    name: 'p1',
    environments: [
      { title: 'QA', baseUrl: site1.url, isDefault: true, secrets: ['STAND_PASSWORD'] },
      { title: 'panel', baseUrl: 'http://127.0.0.1:5178' },
    ],
  });
  await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
  await openRecorded(ctx, page, paths.p1);
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Что пройти на стенде').fill('W3-LOGIN войти под demo с паролем стенда');
  await modal
    .getByLabel('Окружение')
    .selectOption(ctx.envP1.QA)
    .catch(() => undefined);
  const opened = page.waitForResponse((r) => r.url().endsWith('/api/project-tests/recorded/walk'));
  await modal.getByRole('button', { name: 'Начать проход' }).click();
  const reply = await (await opened).json().catch(() => ({}));
  const taskId = reply.taskId;
  check('окно начало проход ядра', typeof taskId === 'string', JSON.stringify(reply));
  if (!taskId) return;
  ctx.tasks.add(taskId);
  ctx.recordTask = taskId;
  // Окно закрыли посреди прохода и перечитали страницу: проход платный и идёт в ядре — окно
  // снова показывает его, а не пустую цель.
  await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  const showsWalk = async () =>
    (await modal.getByLabel('Что пройти на стенде').count()) === 0 &&
    (await modal.getByText(/Ядро проходит стенд|Проход кончился/).count()) > 0;
  check(
    'окно, закрытое посреди прохода, снова показывает проход',
    Boolean(await until(showsWalk, 15)),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openRecorded(ctx, page, paths.p1);
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  check(
    'после перечитки страницы окно показывает тот же проход',
    Boolean(await until(showsWalk, 15)),
  );
  const ended = modal.getByText(/Проход кончился: шагов \d+, удавшихся \d+, пробелов \d+/);
  await ended.waitFor({ timeout: 300_000 }).catch(() => undefined);
  const endedText = (await ended.innerText().catch(() => '')).trim();
  const walk = await walkOf(stand, taskId);
  const okSteps = (walk?.steps ?? []).filter((s) => s.ok).length;
  check(
    `проход кончился и окно назвало счёт: «${endedText}»`,
    endedText !== '' && okSteps >= 5,
    JSON.stringify((walk?.steps ?? []).map((s) => [s.action, s.ok, s.problems])).slice(0, 900),
  );
  const fill = (walk?.steps ?? []).find((s) => s.secret?.name === 'STAND_PASSWORD');
  check(
    'ввод доступа записан по имени, без значения',
    Boolean(fill) && fill.ok && !JSON.stringify(walk).includes(ctx.SECRETS.STAND_PASSWORD),
    JSON.stringify(fill),
  );
  check(
    'стенд получил ровно значение доступа (отпечаток sha256 совпал)',
    site1.hashes().includes(sha256(ctx.SECRETS.STAND_PASSWORD)),
    JSON.stringify(site1.hashes()),
  );
  await modal.getByLabel('Название сценария').fill('Вход W3');
  await modal.getByRole('button', { name: 'Записать в кейс и спек' }).click();
  const saved = modal.getByText(/Записано: /);
  await saved.waitFor({ timeout: 30_000 }).catch(() => undefined);
  const savedText = (await saved.innerText().catch(() => '')).trim();
  check('проход записан в кейс и спек', savedText !== '', await modal.innerText().catch(() => ''));
  ctx.specFile = /Записано: (\S+)/.exec(savedText)?.[1] ?? '';
  const spec = ctx.specFile ? stand.read(join(paths.p1, ctx.specFile)) : null;
  check(
    'спек вводит доступ по имени из окружения, значения в нём нет',
    Boolean(spec) && spec.includes('STAND_PASSWORD') && !spec.includes(ctx.SECRETS.STAND_PASSWORD),
    String(spec).slice(0, 600),
  );
  await shoot(ctx, page, 'recorded-saved');
  await modal
    .getByRole('button', { name: 'Готово', exact: true })
    .click()
    .catch(() => undefined);
}

// ── 1б. прогон без модели, расхождение ──────────────────────────────────────────────────────────

export async function walkReplay(ctx, page) {
  const { stand, check, paths, site1 } = ctx;
  if (!ctx.specFile) {
    check('прогон записанного: есть что гнать', false, 'запись не удалась — прогон не проверен');
    return;
  }
  await openRecorded(ctx, page, paths.p1);
  const calls = () => modelBodies(ctx).length;
  const before = calls();
  const hashesBefore = site1.hashes().length;
  await page.getByRole('button', { name: 'Прогнать все' }).click();
  const green = page.getByText(/Все записанные сценарии прошли \(\d+\), модель не вызывалась\./);
  await green.waitFor({ timeout: 240_000 }).catch(() => undefined);
  check(
    'прогон записанного прошёл: «модель не вызывалась»',
    (await green.count()) > 0,
    (
      await page
        .getByTestId('recorded-replay-state')
        .innerText()
        .catch(() => '')
    ).slice(0, 400),
  );
  check(
    `прогон без единого вызова модели (тел было ${before}, стало ${calls()})`,
    calls() === before,
  );
  check(
    'прогон ввёл доступ на стенде (новый отпечаток того же значения)',
    site1.hashes().slice(hashesBefore).includes(sha256(ctx.SECRETS.STAND_PASSWORD)),
    JSON.stringify(site1.hashes()),
  );

  // Поле пароля стало числовым — ввод доступа падает; ошибка без значения, одна задача прохода.
  site1.state.numberMode = true;
  const tasksBefore = ((await stand.api('/core/tasks')).body?.tasks ?? []).length;
  try {
    await page.getByRole('button', { name: 'Прогнать все' }).click();
    const card = page.getByTestId('recorded-mismatch');
    await card.waitFor({ timeout: 300_000 }).catch(() => undefined);
    const cardText = (await card.innerText().catch(() => '')).trim();
    check('прогон встал на расхождении — карточка расхождения', cardText !== '', cardText);
    check(
      'ошибка расхождения без значения доступа',
      cardText !== '' && !cardText.includes(ctx.SECRETS.STAND_PASSWORD),
      cardText.slice(0, 600),
    );
    const links = await card.getByRole('link').count();
    check('у расхождения ровно одна задача прохода', links === 1, `ссылок ${links}`);
    const mismatchTask = new URL(
      (await card
        .getByRole('link')
        .first()
        .getAttribute('href')
        .catch(() => '')) || 'http://x/',
      stand.webUrl,
    ).searchParams.get('id');
    if (mismatchTask) ctx.tasks.add(mismatchTask);
    const recorded = (
      await stand.api(`/project-tests/recorded?path=${encodeURIComponent(paths.p1)}`)
    ).text;
    check(
      'ответ «Сценарии» (история, расхождение) без значения доступа',
      !recorded.includes(ctx.SECRETS.STAND_PASSWORD),
    );
    await shoot(ctx, page, 'recorded-mismatch');
    await card.getByRole('button', { name: 'Дефект продукта' }).click();
    const marked = page.getByText('Отмечено: дефект продукта');
    await marked.waitFor({ timeout: 15_000 }).catch(() => undefined);
    check('«Дефект продукта» принят', (await marked.count()) > 0);
    const tasksAfter = await until(async () => {
      const list = (await stand.api('/core/tasks')).body?.tasks ?? [];
      return list.length > tasksBefore ? list.length : null;
    }, 120);
    check(
      `расхождение подняло ОДНУ задачу прохода (было ${tasksBefore}, стало ${tasksAfter ?? tasksBefore})`,
      tasksAfter === tasksBefore + 1,
    );
  } finally {
    site1.state.numberMode = false;
  }
}

// ── 2. за пределы стендов, порты панели, доступ в числовое поле ─────────────────────────────────

export async function walkAway(ctx) {
  const { check, paths, foreign, SECRETS } = ctx;
  const { taskId, walk } = await walkViaApi(ctx, {
    path: paths.p1,
    goal: 'W3-AWAY уйти по ссылке и по переходу, открыть панель',
    environmentId: ctx.envP1?.QA,
  });
  const results = toolResults(ctx, 'W3-AWAY');
  const refusals = results.filter((r) => r.text.includes('origin-not-allowed'));
  check(
    `«чужой сайт» не получил ни одного запроса (получил ${foreign.hits()})`,
    foreign.hits() === 0,
    JSON.stringify(foreign.seen),
  );
  check(
    'переход 302 и ссылка за пределы стендов — отказ до запроса',
    refusals.filter((r) => r.text.includes(foreign.host)).length >= 1 ||
      (walk.steps ?? []).some((s) => !s.ok && JSON.stringify(s).includes(foreign.host)),
    JSON.stringify(results.map((r) => r.text.slice(0, 200))).slice(0, 1500),
  );
  const panel = refusals.filter((r) => r.text.includes('agentdeck panel itself'));
  check(
    `порты панели 8888 и 5178 — отказ (отказов «панель» ${panel.length})`,
    panel.some((r) => r.text.includes(':8888')) && panel.some((r) => r.text.includes(':5178')),
    JSON.stringify(results.map((r) => r.text.slice(0, 200))).slice(0, 1500),
  );
  const numberFill = results.find(
    (r) => r.error && /number|secret/i.test(r.text) && !r.text.includes('origin-not-allowed'),
  );
  check(
    'доступ в числовое поле — ошибка без значения доступа',
    results.every((r) => !r.text.includes(SECRETS.STAND_PASSWORD)) &&
      JSON.stringify(walk).indexOf(SECRETS.STAND_PASSWORD) < 0,
    JSON.stringify(numberFill ?? null).slice(0, 400),
  );
  ctx.awayTask = taskId;

  // Окружение, записанное на адрес API панели: сама запись не делает его стендом.
  const panelWalk = await walkViaApi(ctx, {
    path: paths.p1,
    goal: 'W3-PANEL открыть стенд окружения panel',
    environmentId: ctx.envP1?.panel,
  });
  const panelResults = toolResults(ctx, 'W3-PANEL');
  check(
    'окружение с адресом панели (5178) — проход там всё равно отказан',
    panelResults.some(
      (r) => r.text.includes('origin-not-allowed') && r.text.includes('agentdeck panel itself'),
    ) && (panelWalk.walk.steps ?? []).every((s) => !s.ok),
    JSON.stringify(panelResults.map((r) => r.text.slice(0, 200))).slice(0, 800),
  );
}

// ── 3. проект в подкаталоге репозитория ─────────────────────────────────────────────────────────

export async function walkSubfolder(ctx, browser) {
  const { stand, check, paths, site2, SECRETS } = ctx;
  ctx.envP2 = await seedProject(ctx, {
    path: paths.p2,
    name: 'app',
    environments: [{ title: 'sub', baseUrl: site2.url, isDefault: true, secrets: ['SUB_TOKEN'] }],
  });
  const { walk, view: v } = await walkViaApi(ctx, {
    path: paths.p2,
    goal: 'W3-SUB войти своим доступом проекта',
    environmentId: ctx.envP2.sub,
  });
  const results = toolResults(ctx, 'W3-SUB');
  check(
    'проход копией проекта в подкаталоге: свой доступ ввёлся (отпечаток SUB_TOKEN)',
    site2.hashes().includes(sha256(SECRETS.SUB_TOKEN)),
    JSON.stringify({
      hashes: site2.hashes(),
      steps: (walk.steps ?? []).map((s) => [s.action, s.ok]),
    }),
  );
  check(
    'чужой доступ (STAND_PASSWORD проекта p1) этому проекту не отдан',
    !site2.hashes().includes(sha256(SECRETS.STAND_PASSWORD)) &&
      results.some((r) => r.error && r.text.includes('STAND_PASSWORD')),
    JSON.stringify(results.map((r) => r.text.slice(0, 200))).slice(0, 800),
  );
  // CLI прохода работает в подкаталоге копии: рабочий каталог сессии — `<копия>/app`.
  const cwd = workDirsOf(ctx, 'W3-SUB');
  check(
    'сессия прохода идёт в подкаталоге копии репозитория (…\\app), не в самом репозитории',
    cwd.some((d) => /[\\/]app$/i.test(d) && !samePath(d, paths.p2)),
    JSON.stringify({ cwd, repos: v?.repos ?? v?.task?.repos }).slice(0, 600),
  );
  // Чат на месте: в подкаталоге проекта (бриф чата — `agentdeck-root:`).
  const { openProjectChat } = await import('./chat-walk.mjs');
  const page = await openProjectChat(stand, browser, paths.p2, 'app');
  try {
    const input = page.locator('textarea[data-chat-input]');
    await input.fill('W3 чат в подкаталоге');
    await input.press('Enter');
    const answered = await until(() => page.getByText('W3 ответ чата').count(), 180);
    check('чат проекта в подкаталоге ответил', Boolean(answered));
    const roots = rootsOf(ctx, 'W3 чат в подкаталоге');
    check(
      'чат идёт на месте в подкаталоге проекта (agentdeck-root: …mono\\app)',
      roots.some((r) => samePath(r, paths.p2)),
      JSON.stringify(roots),
    );
    check('страница чата без ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await page.close();
  }
}

/** Рабочие каталоги сессий, где встретилась метка: строки окружения системного промпта CLI. */
function workDirsOf(ctx, marker) {
  const out = new Set();
  for (const body of modelBodies(ctx)) {
    const text = JSON.stringify(body);
    if (!text.includes(marker)) continue;
    for (const m of text.matchAll(
      /(?:Primary working directory|Working directory): ([^"\\]+(?:\\\\[^"\\]+)*)/g,
    ))
      out.add(m[1].replace(/\\\\/g, '\\').trim());
  }
  return [...out];
}

/** Корни, которые бриф чата/задачи назвал модели (`agentdeck-root:` / `agentdeck-copy:`). */
function rootsOf(ctx, marker) {
  const out = new Set();
  for (const body of modelBodies(ctx)) {
    const text = JSON.stringify(body);
    if (!text.includes(marker)) continue;
    for (const m of text.matchAll(/agentdeck-(?:root|copy): ?([^"\\]+(?:\\\\[^"\\]+)*)/g))
      out.add(m[1].replace(/\\\\/g, '\\').trim());
  }
  return [...out];
}

const norm = (p) =>
  String(p)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
const samePath = (a, b) => norm(a) === norm(b);

// ── 4. значение доступа — ни в одном файле стенда ───────────────────────────────────────────────

export async function walkSecretSweep(ctx) {
  const { stand, check, SECRETS } = ctx;
  const values = Object.values(SECRETS);
  const hits = [];
  let files = 0;
  const visit = (dir, depth) => {
    if (depth > 14) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full, depth + 1);
      else if (st.size < 30 * 1024 * 1024) {
        files += 1;
        let buf;
        try {
          buf = readFileSync(full);
        } catch {
          continue;
        }
        for (const v of values)
          if (buf.includes(Buffer.from(v)) || buf.includes(Buffer.from(v, 'utf16le')))
            hits.push(full);
      }
    }
  };
  visit(stand.root, 0);
  const traces = JSON.stringify(ctx.cliTrace);
  check(
    `значения доступов — ни в одном файле стенда (просмотрено ${files}: журналы ядра, след модели, спеки, стенограммы)`,
    files > 50 && hits.length === 0,
    hits.slice(0, 10).join(' | '),
  );
  check(
    'значения доступов — ни в одном теле запроса модели (вход CLI)',
    values.every((v) => !traces.includes(v)),
  );
  check(
    'журнал панели и ядра без значений доступов',
    values.every((v) => !stand.log().includes(v) && !stand.coreLog().includes(v)),
  );
}

// ── общее ───────────────────────────────────────────────────────────────────────────────────────

/** «Тесты» → «Сценарии» выбранного проекта (выбор проекта — подписью «Проект»). */
export async function openRecorded(ctx, page, path) {
  await page.goto(`${ctx.stand.webUrl}/tests?tab=recorded`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  const picker = page.getByLabel('Проект', { exact: true });
  if ((await picker.count()) > 0) {
    const options = await picker
      .locator('option')
      .evaluateAll((list) => list.map((o) => ({ value: o.value, text: o.textContent ?? '' })));
    const want = options.find(
      (o) => o.value === path || norm(o.value) === norm(path) || o.text.includes(path),
    );
    if (want) await picker.selectOption(want.value);
  }
  await page.getByRole('button', { name: 'Записать сценарий' }).waitFor({ timeout: 30_000 });
}

export async function shoot(ctx, page, name) {
  if (!ctx.SHOTS) return;
  await page.screenshot({ path: join(ctx.SHOTS, `${name}.png`) }).catch(() => undefined);
}
