/**
 * Кадры документа «Ядро задач» (`core`): запуск, вопросы, лента, сценарии, плашки отказа.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель, своё ядро со своим
 * временным домом, настоящий `claude` из PATH человека против сценария `packages/stub-model`
 * (модель — единственное, что подменено; сценарий тот же, что у `tools/qa/check-core-timeline.mjs`).
 * Браузер ходит через прокладку панели `/api/core/*`, ответы ядра не перехватываются — кроме кадра
 * плашки «звено не записано»: стенд записывает себя ядру сам, и показать плашку можно только
 * переписав в ответе `health` поле `trustedHops` (остальной ответ — настоящий).
 *
 * Варианты кадра (тема × язык) снимаются ОДНИМ прогоном: язык и тема — настройкой панели
 * (`applyShotLanguage`) с перезагрузкой страницы. Экран запуска держит форму в памяти страницы,
 * поэтому каждый вариант оценивает свою задачу заново; лента и вопросы живут в ядре и
 * переживают перезагрузку.
 *
 * Запуск: node tools/help-shots/core-panel.mjs (нужен `claude` в PATH; без него — код 2).
 * `FRAMES=07-review-link[,01-form]` — переснять только названные кадры экрана запуска: прочие не
 * снимаются, сценарии после запуска (вопросы, лента) пропускаются, опись сценария сохраняет
 * старые кадры (`openScenario` сливает); `VARIANTS=dark-en` в паре с ним сужает варианты.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { uuidv7 } from '../qa/core-scenario-stand.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';

const TOPIC = 'core';
const TIMELINE_QA = join(import.meta.dirname, '..', 'qa', 'check-core-timeline.mjs');
const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
/** «Отменить задачу» точки 6 на языке задачи (`apps/core/src/conductor/next/answers.ts`). */
const CANCEL = { ru: 'Отменить задачу', en: 'Cancel the task' };
/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
const TASK = {
  title: 'README.md: typo',
  request: 'Fix the typo in README.md.',
};
const LABELS = {
  ru: {
    title: 'Название',
    request: 'Требования',
    repo: 'Путь к репозиторию',
    mrUrl: 'Ссылка на MR или PR',
  },
  en: { title: 'Title', request: 'Requirements', repo: 'Repository path', mrUrl: 'MR or PR link' },
};
/** MR для кадра ревью по ссылке: remote репозитория на хосте без API форжа — отказ «форжа нет». */
const REVIEW_SITE = 'https://tracker.example/group/app';
const ONLY = new Set(
  (process.env.FRAMES ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);
const wanted = (id) => ONLY.size === 0 || ONLY.has(id);
/** `VARIANTS=dark-en[,light-ru]` — вместе с `FRAMES`: доснять пропавшие варианты, не все четыре. */
const ONLY_VARIANTS = new Set(
  ONLY.size === 0
    ? []
    : (process.env.VARIANTS ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
);
/** Состояние надзора для кадра сбоя: пять падений за десять минут, код выхода, хвост журнала. */
const FAULT_STATUS = {
  state: 'fault',
  pid: null,
  restarts: 5,
  lastExit: { code: 1, signal: null, at: '2026-11-02T09:41:07.000Z' },
  nextRetryAt: null,
  logTail: [
    '[core] boot: reading config.json',
    '[core] boot: config.json: Unexpected token } in JSON at position 412',
    '[core] exit 1',
  ],
  autostart: 'off',
};
/** Выбранные кадры сняты: остаток прогона пропускается этим значением, а не ошибкой. */
const FRAMES_DONE = Symbol('frames-done');

const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
  encoding: 'utf8',
});
const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';
if (!claudeAt) {
  console.error('claude не найден в PATH — ленте ядра нужен CLI; кадры не сняты');
  process.exit(2);
}

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
let repo = '';
let reviewRepo = '';

const stand = await startStand({
  label: 'core-help-shots',
  extraPath: [dirname(claudeAt)],
  core: {
    stub: [
      {
        name: 'stand',
        script: {
          module: TIMELINE_QA,
          export: 'stepDoneScript',
          args: [
            {
              checkArgv: CHECK_ARGV,
              extra: { extracted: [{ text: TASK.request, source: 'request' }] },
            },
          ],
        },
      },
    ],
  },
  seed: ({ root, cfg, coreHome }) => {
    repo = join(root, 'repo');
    mkdirSync(join(repo, '.agentdeck'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'stand']);
    git(repo, ['config', 'user.email', 'stand@example.invalid']);
    writeFileSync(join(repo, 'README.md'), '# Shop\n\nInstal the app with pnpm.\n');
    // Проверка в реестре репозитория: argv вне реестра ядро отклоняет (`not-registered`).
    writeFileSync(
      join(repo, '.agentdeck', 'checks.json'),
      `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
    );
    // Репозиторий пытается включить ожидание CI — ядро отвергает правку, экран запуска это
    // показывает карточкой «Отвергнутые правки».
    writeFileSync(
      join(repo, '.agentdeck', 'scenario.json'),
      JSON.stringify({ v: 1, ciWait: true }),
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);
    // Отдельный репозиторий для ревью по ссылке: remote задачи запуска остаётся пустым, и
    // её публикация не стучится на чужой хост.
    reviewRepo = join(root, 'review-repo');
    mkdirSync(reviewRepo, { recursive: true });
    git(reviewRepo, ['init', '-q', '-b', 'main']);
    git(reviewRepo, ['remote', 'add', 'origin', `${REVIEW_SITE}.git`]);
    // Кадр «Серверы MCP для шагов»: серверы человека — в конфиге самого Claude Code стенда, ответ
    // ядра настоящий. `orders` — живой MCP (`demo-mcp-server.mjs`), `docs` — сетевой, его никто не
    // выбирает; `old-tracker` выбран, но никем не предложен — плашка «ни один CLI не предлагает».
    // Выбор только у вида `fix`: прогону ленты (шаг work, проверки зелёные) он не достаётся.
    writeFileSync(
      join(cfg, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          orders: {
            command: process.execPath,
            args: [join(import.meta.dirname, 'demo-mcp-server.mjs')],
          },
          docs: { type: 'http', url: 'https://docs.example.invalid/mcp' },
        },
      }),
    );
    const cfgPath = join(coreHome, 'config.json');
    const doc = JSON.parse(readFileSync(cfgPath, 'utf8'));
    doc.mcpPicks = { fix: ['old-tracker', 'orders'] };
    writeFileSync(cfgPath, `${JSON.stringify(doc, null, 2)}\n`);
  },
});

const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
const coreUrl = () =>
  JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1).url;

/** Засев прямо в ядро (маршрут и модель задачи — настройка, не экран документа). */
async function direct(method, path, body) {
  const res = await fetch(`${coreUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}
async function proof() {
  const page = uuidv7();
  const minted = await direct('GET', `/v1/nonce?page=${page}`);
  return { nonce: minted.body?.nonce, page };
}
async function command(taskId, kind, fields) {
  return direct('POST', '/v1/commands', {
    cmdId: uuidv7(),
    kind,
    target: { taskId },
    fields,
    proof: await proof(),
  });
}
/** Задача ходит только заглушкой: маршрут и модель ставятся сразу за оценкой, как в QA ленты. */
async function pinStubRoute(taskId) {
  const route = await command(taskId, 'set-route', {
    scope: 'task',
    scopeId: taskId,
    allowedRoutes: [
      { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
    ],
  });
  const model = await command(taskId, 'set-model', {
    scope: 'task',
    scopeId: taskId,
    model: 'stub-model',
    effort: null,
    timing: 'now',
  });
  if (route.status !== 200 || model.status !== 200) {
    throw new Error(`маршрут/модель задачи ${taskId}: ${route.text} ${model.text}`);
  }
}
function journal(taskId) {
  const dir = join(stand.coreHome, 'tasks', taskId);
  const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
async function until(what, probe, seconds) {
  for (let i = 0; i < seconds; i++) {
    const got = await probe();
    if (got) return got;
    await wait(1000);
  }
  throw new Error(`не дождались: ${what}`);
}

/** Перевести панель в вариант кадра и дождаться, что страница его действительно показывает. */
async function toVariant(page, variant, url) {
  await applyShotLanguage(stand.apiUrl, variant.lang, variant.theme);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    ([lang, theme]) =>
      document.documentElement.lang.startsWith(lang) &&
      document.documentElement.dataset.theme === theme,
    [variant.lang, variant.theme],
    { timeout: 90_000 },
  );
}

/**
 * Кадр, переживающий перезагрузку страницы. Фронт стенда смотрит в живое дерево исходников, и
 * чужая правка модуля во время съёмки перезагружает страницу целиком (Vite full reload): раскрытые
 * детали и открытая запись пропадают, а кадр области снимался по пустому месту («Clipped area is
 * either empty»). Метка на `window` живёт до перезагрузки: пропала — состояние кадра собирается
 * заново (`prepare`) и кадр снимается ещё раз; ошибка без перезагрузки — настоящая и летит дальше.
 */
async function framed(page, id, prepare, take) {
  if (!wanted(id)) return;
  for (let attempt = 1; ; attempt++) {
    await page.waitForSelector('nav', { timeout: 60_000 });
    let failure = null;
    try {
      // Метка ставится внутри попытки: перезагрузка в этот самый миг — тоже повод повторить.
      await page.evaluate(() => {
        window.__coreShotMark = true;
      });
      await prepare();
      await take();
    } catch (error) {
      failure = error;
    }
    const kept = await page.evaluate(() => window.__coreShotMark === true).catch(() => false);
    if (kept && !failure) return;
    if (kept || attempt >= 5)
      throw failure ?? new Error(`кадр ${id}: страница перезагружалась ${attempt} раз подряд`);
    console.log(
      `  кадр ${id}: страница перезагрузилась во время кадра — снимаю заново (${attempt})`,
    );
    await page.waitForLoadState('domcontentloaded');
  }
}

/** Кадр области: собрать состояние, прокрутить к ней (у панели своя прокрутка) и снять с полями. */
async function shotArea(scenario, page, id, selector, padding = 16, prepare = async () => {}) {
  await framed(page, id, prepare, async () => {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout: 60_000 });
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.mouse.move(2, 2);
    await wait(500);
    await scenario.shot(page, id, { clip: selector, padding, maskText: MASKS });
  });
}
async function shotWindow(scenario, page, id, prepare = async () => {}) {
  await framed(page, id, prepare, async () => {
    await page.mouse.move(2, 2);
    await wait(500);
    await scenario.shot(page, id, { maskText: MASKS });
  });
}

/** Сценарий на вариант: открыть, снять, закрыть — описи разных вариантов не перебивают друг друга. */
async function eachVariant(page, name, url, body) {
  for (const variant of SHOT_VARIANTS.filter(
    (v) => !ONLY_VARIANTS.size || ONLY_VARIANTS.has(v.key),
  )) {
    console.log(`\nсценарий ${TOPIC}/${name} [${variant.key}]`);
    await toVariant(page, variant, url);
    const scenario = openScenario(TOPIC, name, variant.lang, variant.theme);
    await body(scenario, variant);
    // Съёмка по выбору (`FRAMES`) не снимает с учёта кадры, которых в выборе не было.
    scenario.finish({ keepUnshot: ONLY.size > 0 });
  }
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const page = await stand.newPage(browser, { width: 1280, height: 900 });
  const taskIds = [];
  /** Язык панели, с которой задача запущена: вопрос запуска ядро пишет на нём. */
  const langOf = new Map();

  // ── Ядро не запускается: карточка сбоя надзора ────────────────────────────────────────────
  // Сбой — заглушка состояния надзора и отказ прокладки: настоящее ядро стенда ради кадра пришлось
  // бы ронять пять раз за десять минут. Стоит до запуска — `FRAMES=01-fault` доходит до него.
  const faultRoutes = [
    ['**/api/core/supervisor', (route) => route.fulfill({ json: FAULT_STATUS })],
    [
      '**/api/core/tasks**',
      (route) =>
        route.fulfill({
          status: 503,
          json: { code: 'core-fault', messageCode: 'core-fault', detail: 'core exited 5 times' },
        }),
    ],
  ];
  if (wanted('01-fault')) {
    for (const [glob, handler] of faultRoutes) await page.route(glob, handler);
    await eachVariant(page, 'fault', `${stand.webUrl}/core`, async (scenario) => {
      await shotArea(scenario, page, '01-fault', '[data-core-refusal="core-fault"]', 24);
    });
    for (const [glob, handler] of faultRoutes) await page.unroute(glob, handler);
  }

  // Оценка из формы: ответ ядра доходит до браузера настоящим, а маршрут-заглушка ставится за ним
  // вслед — так же быстро, как в QA ленты, до первого шага задачи.
  await page.route('**/api/core/estimate', async (route) => {
    const sent = route.request().postDataJSON();
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    if (body.taskId && !taskIds.includes(body.taskId)) {
      taskIds.push(body.taskId);
      langOf.set(body.taskId, sent?.fields?.lang);
      await pinStubRoute(body.taskId);
    }
    await route.fulfill({ response, json: body });
  });

  // ── Запуск: форма → оценка и дороги → деление ─────────────────────────────────────────────
  // Высокое окно: карточка дорог выше обычного экрана, а кадр области не выходит за окно.
  await page.setViewportSize({ width: 1280, height: 1500 });
  await eachVariant(page, 'launch', `${stand.webUrl}/core/launch`, async (scenario, variant) => {
    // Форма и оценка живут в памяти страницы: после перезагрузки (`framed`) их собирают заново —
    // форма заполняется, оценка запрашивается ещё раз (лишняя задача ядра кадрам не мешает).
    const form = page.locator('[data-core-launch-form]');
    const labels = LABELS[variant.lang];
    const filled = async () => {
      await form.waitFor({ timeout: 90_000 });
      const title = form.getByLabel(labels.title, { exact: true });
      if ((await title.inputValue()) === TASK.title) return;
      await title.fill(TASK.title);
      await form.getByLabel(labels.request, { exact: true }).fill(TASK.request);
      await form.getByLabel(labels.repo, { exact: true }).fill(repo);
      await form.locator('select').first().selectOption('preset:bug-fix');
    };
    const estimated = async () => {
      const roads = page.locator('[data-launch-section="roads"]');
      if ((await roads.count()) > 0) return;
      await filled();
      await page.locator('[data-estimate-button]').click();
      await roads.waitFor({ timeout: 90_000 });
    };
    // Деление приходит потоком после первого шага плана — ждём карточку с единицами.
    const split = async () => {
      await estimated();
      await page
        .locator('[data-split-unit]')
        .first()
        .waitFor({ timeout: 240_000 })
        .catch(() => console.log('  деление не пришло — кадр с ожиданием'));
    };
    await shotArea(scenario, page, '01-form', '[data-launch-section="form"]', 16, filled);
    const est = '[data-launch-section="estimate"]';
    await shotArea(scenario, page, '02-estimate', est, 16, estimated);
    await shotArea(scenario, page, '03-roads', '[data-launch-section="roads"]', 16, estimated);
    await shotArea(
      scenario,
      page,
      '04-rejected',
      '[data-launch-section="rejected"]',
      16,
      estimated,
    );
    await shotArea(scenario, page, '05-split', '[data-launch-section="split"]', 16, split);
    await shotArea(scenario, page, '06-launch', '[data-launch-section="launch"]', 16, split);
    // Ревью по ссылке: настоящий отказ ядра — remote без API форжа, MR не прочесть.
    const reviewForm = page.locator('[data-review-link-form]');
    const refused = async () => {
      if ((await page.locator('[data-review-link-refusal]').count()) > 0) return;
      await reviewForm.waitFor({ timeout: 90_000 });
      await reviewForm
        .getByLabel(labels.mrUrl, { exact: true })
        .fill(`${REVIEW_SITE}/-/merge_requests/12`);
      await reviewForm.getByLabel(labels.repo, { exact: true }).fill(reviewRepo);
      await page.locator('[data-review-link-button]').click();
      await page.locator('[data-review-link-refusal]').waitFor({ timeout: 90_000 });
    };
    await shotArea(
      scenario,
      page,
      '07-review-link',
      '[data-launch-section="review-link"]',
      16,
      refused,
    );
    // Выбор MCP: строки — настоящий ответ `GET /mcp-offers` ядра стенда (засев выше).
    await shotArea(
      scenario,
      page,
      '08-mcp-picks',
      '[data-launch-section="mcp-picks"]',
      16,
      async () => {
        await page.locator('[data-mcp-row="orders"]').waitFor({ timeout: 90_000 });
      },
    );
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (ONLY.size > 0) {
    console.log(`\nFRAMES=${[...ONLY].join(',')}: сценарии после запуска пропущены`);
    throw FRAMES_DONE;
  }

  const taskId = taskIds[0];
  if (!taskId) throw new Error('оценка из формы не создала задачу');
  const taskUrl = `${stand.webUrl}/core?id=${taskId}`;

  // ── Вопрос запуска на ленте ───────────────────────────────────────────────────────────────
  const launchAskOf = (id) =>
    until(
      'вопрос запуска в журнале',
      () => journal(id).find((l) => l.kind === 'human.asked' && l.data?.source === 'launch'),
      240,
    );
  const launchAsk = await launchAskOf(taskId);
  // Кадр варианта — задача, запущенная с панели того же языка: вопрос ядро пишет на её языке.
  const askTaskOf = (lang) => taskIds.find((id) => langOf.get(id) === lang) ?? taskId;
  for (const lang of new Set(SHOT_VARIANTS.map((v) => v.lang))) await launchAskOf(askTaskOf(lang));
  for (const variant of SHOT_VARIANTS) {
    const url = `${stand.webUrl}/core?id=${askTaskOf(variant.lang)}`;
    console.log(`\nсценарий ${TOPIC}/ask [${variant.key}]`);
    await toVariant(page, variant, url);
    const scenario = openScenario(TOPIC, 'ask', variant.lang, variant.theme);
    // Блок целиком, с заголовком «Ждёт человека»: поля вокруг одной карточки резали его пополам.
    await shotArea(
      scenario,
      page,
      '01-launch',
      '[data-core-asks]:has([data-core-ask][data-ask-source="launch"])',
    );
    scenario.finish();
  }
  // Задача русской панели одобряется с карточки (настоящий путь кнопки), английской — командой:
  // её кадры дальше — вопрос кругов и лента на английском, ответ запуска в кадр не идёт.
  await page.goto(taskUrl, { waitUntil: 'domcontentloaded' });
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/core\/commands$/.test(r.url()),
  );
  await page
    .locator('[data-core-ask][data-ask-source="launch"] [data-ask-option="approve-split"]')
    .click();
  const reply = await (await answered).json().catch(() => ({}));
  if (reply.status !== 'applied') {
    console.log(`  ответ с карточки не принят (${JSON.stringify(reply)}) — прямо в ядро`);
    const r = await command(taskId, 'approve-split', {
      splitId: launchAsk.data.dedupe.slice('split:'.length),
    });
    if (r.body?.status !== 'applied') throw new Error(`ответ запуска: ${r.text}`);
  }
  const langs = [...new Set(SHOT_VARIANTS.map((v) => v.lang))];
  for (const lang of langs) {
    const id = askTaskOf(lang);
    if (id === taskId) continue;
    const ask = await launchAskOf(id);
    const r = await command(id, 'approve-split', {
      splitId: ask.data.dedupe.slice('split:'.length),
    });
    if (r.body?.status !== 'applied') throw new Error(`ответ запуска задачи ${lang}: ${r.text}`);
  }

  // ── Вопрос исчерпанных кругов: у задачи каждого языка свой, на её языке ───────────────────
  const capIdOf = new Map();
  for (const lang of langs) {
    const id = askTaskOf(lang);
    const capAsk = await until(
      `вопрос исчерпанных кругов (${lang})`,
      () =>
        journal(id).find(
          (l) =>
            l.kind === 'human.asked' &&
            l.data?.source === 'round-cap' &&
            !journal(id).some((a) => a.kind === 'human.answered' && a.data?.askId === l.data.askId),
        ),
      300,
    );
    console.log(
      `  вопрос кругов (${lang}): ${capAsk.data.question} | ${capAsk.data.options.join(' / ')}`,
    );
    capIdOf.set(lang, capAsk.data.askId);
  }
  const capUrl = (lang) => `${stand.webUrl}/core?id=${askTaskOf(lang)}`;
  for (const variant of SHOT_VARIANTS) {
    const capId = capIdOf.get(variant.lang);
    console.log(`\nсценарий ${TOPIC}/cap [${variant.key}]`);
    await toVariant(page, variant, capUrl(variant.lang));
    await until(
      'карточка вопроса кругов',
      async () => {
        await page.goto(capUrl(variant.lang), { waitUntil: 'domcontentloaded' });
        return page
          .locator(`[data-core-ask="${capId}"]`)
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
      },
      60,
    );
    const questionLang = await page
      .locator(`[data-core-ask="${capId}"] [data-ask-question]`)
      .getAttribute('lang');
    console.log(`  lang у текста вопроса: ${questionLang ?? '(нет — язык страницы)'}`);
    const scenario = openScenario(TOPIC, 'cap', variant.lang, variant.theme);
    await shotArea(
      scenario,
      page,
      '01-round-cap',
      `[data-core-asks]:has([data-core-ask="${capId}"])`,
    );
    scenario.finish();
  }
  for (const lang of langs) {
    const id = askTaskOf(lang);
    const late = await command(id, 'answer', { askId: capIdOf.get(lang), answer: CANCEL[lang] });
    if (late.body?.status !== 'applied')
      throw new Error(`ответ на вопрос кругов (${lang}): ${late.text}`);
  }
  for (const lang of langs) {
    await until(
      `итоговый отчёт ядра (${lang})`,
      async () => (await stand.api(`/core/tasks/${askTaskOf(lang)}`)).body?.view?.report,
      300,
    );
  }

  // ── Лента после конца: обзор, решение с «почему», проверка с записью, отчёт ──────────────
  for (const variant of SHOT_VARIANTS) {
    console.log(`\nсценарий ${TOPIC}/timeline [${variant.key}]`);
    await toVariant(page, variant, capUrl(variant.lang));
    const scenario = openScenario(TOPIC, 'timeline', variant.lang, variant.theme);
    await shotWindow(scenario, page, '01-overview', async () => {
      await page.locator('[data-core-timeline]').waitFor({ timeout: 60_000 });
      await page.locator('[data-core-report]').waitFor({ timeout: 60_000 });
      await wait(1500);
    });

    // Решение, у которого есть причины: раскрыть «детали».
    await shotArea(scenario, page, '02-decision', '[data-help-focus="decision"]', 24, async () => {
      const decision = page.locator('li[data-core-row]:has([data-decision-class] details)').nth(2);
      await decision.locator('summary').first().click();
      await decision.evaluate((node) => node.setAttribute('data-help-focus', 'decision'));
    });

    await shotArea(
      scenario,
      page,
      '03-check',
      'li[data-core-row]:has([data-record-peek])',
      16,
      async () => {
        if ((await page.locator('[data-record-peek] [data-record-verdict]').count()) > 0) return;
        const link = page.locator('[data-record-link]').first();
        await link.scrollIntoViewIfNeeded();
        await link.click();
        await page.locator('[data-record-peek] [data-record-verdict]').first().waitFor({
          timeout: 20_000,
        });
      },
    );

    await shotArea(scenario, page, '04-report', '[data-core-report]');
    scenario.finish();
  }

  // ── Список задач и плашка «звено не записано» ─────────────────────────────────────────────
  let hopsGone = false;
  await page.route('**/api/core/health', async (route) => {
    if (!hopsGone) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, trustedHops: { count: 0, recordedAt: null } },
    });
  });
  await eachVariant(page, 'tasks', `${stand.webUrl}/core`, async (scenario) => {
    await page.locator('[data-core-task-list]').waitFor({ timeout: 60_000 });
    await wait(1000);
    await shotWindow(scenario, page, '01-list');
    hopsGone = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-core-hops="unrecorded"]').waitFor({ timeout: 30_000 });
    await shotArea(scenario, page, '02-hops', '[data-core-hops="unrecorded"]');
    hopsGone = false;
  });

  // ── Сценарии: библиотека и редактор нового ────────────────────────────────────────────────
  // Вкладка явно в адресе: страница помнит последнюю вкладку, и голый адрес после кадра
  // нового сценария открыл бы снова его, а не библиотеку.
  await eachVariant(
    page,
    'scenarios',
    `${stand.webUrl}/core/scenarios?tab=library`,
    async (scenario) => {
      await page.locator('[data-scenario-library]').waitFor({ timeout: 60_000 });
      await wait(1000);
      await shotWindow(scenario, page, '01-library');
      await page.goto(`${stand.webUrl}/core/scenarios?tab=new&id=bug-fix@1`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('[data-scenario-editor]').waitFor({ timeout: 60_000 });
      await wait(1000);
      await shotWindow(scenario, page, '02-new');
    },
  );

  // ── Ядро остановлено: карточка «не запущено» ──────────────────────────────────────────────
  process.kill(stand.corePid());
  await wait(2000);
  await eachVariant(page, 'absent', `${stand.webUrl}/core`, async (scenario) => {
    await shotArea(scenario, page, '01-card', '[data-core-refusal="core-absent"]', 24);
  });
} catch (error) {
  if (error !== FRAMES_DONE) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    exitCode = 1;
  }
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
