/**
 * Верхняя панель чата проекта — живой UI на подменённом API.
 *
 * Что проверяется (и что ломалось бы тихо):
 * - поповер «Настройки запуска» (Автозапуск / Команда / Порт) целиком на экране
 *   и ПОВЕРХ всего остального: щелчок-проба в его углах и в первой строке
 *   текста попадает в сам поповер, а не в полосу под шапкой (владелец 28.09:
 *   первая строка срезана, край уходит под панель);
 * - кнопка настроек запуска отличима от «Настроек чата»: разные значки и
 *   разные подписи — две одинаковые шестерёнки рядом не различить;
 * - все элементы управления панели одной высоты, в каждом ряду на одной
 *   средней линии и одного кегля — при 1280 и при 400, ничего не выходит за
 *   край окна и не наезжает на соседа;
 * - Escape закрывает поповер и возвращает фокус на его кнопку.
 *
 * Обе темы: тема подменяется в ответе настроек (bypassOnboarding patch), а не
 * пишется на сервер. Данные подменены целиком (page.route): проект без скрипта
 * dev — ровно случай со снимка владельца — и проект с поднятым сервером (чип
 * адреса в ряду).
 *
 * Запуск: `node tools/qa/check-chat-top-bar.mjs` при поднятом `pnpm dev`
 * (`QA_SCENARIO=light-400,dark-1280-live` — только названные сценарии).
 * `--shots <TAG>` — снимки в `.agent/screenshots/before-after/L2-chat-top-bar/`
 * (`<тема>-<ширина>-<кадр>_<TAG>.png`) и выход без проверок: так снимается
 * «до» на старом коде.
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };
const argv = process.argv.slice(2);
const shotsTag = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : undefined;
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(repo, '.agent', 'screenshots', 'before-after', 'L2-chat-top-bar');
if (shotsTag) mkdirSync(SHOTS, { recursive: true });

/** Кнопка настроек запуска: была голой шестерёнкой «Настройки запуска». */
const RUNNER_NAMES = ['Dev-сервер', 'Настройки запуска'];
const RUNNER_NAME = /^(Dev-сервер|Настройки запуска)$/;
const MENU_LABEL = 'Настройки чата';

/** Все поповеры панели: каждый обязан открываться целиком на экране и поверх. */
const POPOVERS = [
  { title: 'Агенты', name: /^Агенты/ },
  { title: 'До MR', name: /^До MR/ },
  { title: 'Dev-сервер', name: RUNNER_NAME },
  { title: MENU_LABEL, name: new RegExp(`^${MENU_LABEL}$`) },
];

/** Цель без скрипта dev — «Запустить» нет, в ряду только кнопка настроек. */
const TARGET_BARE = {
  dir: '',
  path: PROJECT.path,
  name: 'qa-project',
  runnable: false,
  reason: 'В package.json нет скрипта dev или start. Задайте команду запуска вручную.',
  autostart: false,
};

/** Цель со скриптом, уже поднятая: в ряду чип «Перейти :5173» и «Остановить». */
const TARGET_LIVE = { ...TARGET_BARE, runnable: true, command: 'pnpm run dev', reason: undefined };
const RUN_LIVE = {
  projectPath: PROJECT.path,
  dir: '',
  path: PROJECT.path,
  name: 'qa-project',
  port: 5173,
  url: 'http://localhost:5173',
  status: 'running',
  command: 'pnpm run dev',
  startedAt: '2026-09-28T09:00:00.000Z',
};

const SPLIT_VIEW = {
  deliver: true,
  parallel: 8,
  parallelAuto: true,
  profile: {
    enabled: true,
    repo: true,
    remote: true,
    bootstrapConfigured: false,
    heavy: false,
  },
  permissions: {},
  permissionsOwn: [],
};

const GIT = {
  isRepo: true,
  branch: 'main',
  detached: false,
  unborn: false,
  branches: ['main'],
  dirtyCount: 0,
  changedFiles: [],
  remoteBranches: [],
  insertions: 0,
  deletions: 0,
};

let bad = 0;
/** Итоги текущего сценария: печатаются, только если стенд его не перебил. */
let pending = [];
const check = (ok, text) => pending.push({ ok, text });
const flush = () => {
  for (const { ok, text } of pending) {
    // «✘» — метка провала, по ней раннеры мутантов находят упавшую проверку;
    // поэтому в тексте строк «ок» этого знака (и «×») нет.
    console.log(`${ok ? 'ок   ' : '✘ ПЛОХО'} ${text}`);
    if (!ok) bad += 1;
  }
  pending = [];
};

const browser = await chromium.launch();

/** Открывает вкладку проекта с заданным состоянием запуска. */
async function openProject({ theme, width, height, live, slow }) {
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: theme,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
  // Стенд живой: соседние правки перезагружают модули (HMR) посреди прогона, и
  // открытый поповер пропадает не по вине шапки. Такой сценарий повторяется.
  const stand = { touched: false };
  page.on('console', (message) => {
    if (/\[vite\] (hot updated|page reload|connecting)/.test(message.text())) stand.touched = true;
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && stand.ready) stand.touched = true;
  });
  await bypassOnboarding(page, { theme, language: 'ru' });

  const json = (route, body, status = 200) => route.fulfill({ status, json: body });
  await page.route('**/api/chats', (route) => json(route, []));
  await page.route('**/api/chat/active', (route) => json(route, []));
  await page.route('**/api/chats/projects*', (route) =>
    json(route, [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-28T09:00:00.000Z',
        chats: [],
      },
    ]),
  );
  await page.route('**/api/project-git*', (route) => json(route, GIT));
  await page.route('**/api/project-git/split-settings*', (route) => json(route, SPLIT_VIEW));
  await page.route('**/api/project-runner', (route) => json(route, live ? [RUN_LIVE] : []));
  // slow: ответ «что запускать» приходит позже остальной шапки — группа
  // dev-сервера встаёт в ряд последней, и метки строк обязаны пересчитаться.
  await page.route('**/api/project-runner/describe*', async (route) => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, 2500));
    return json(route, {
      projectPath: PROJECT.path,
      targets: [live ? TARGET_LIVE : TARGET_BARE],
      workspaceSource: 'single',
      skipped: 0,
    });
  });

  try {
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await page.waitForTimeout(1200);
    await page.getByRole('tab', { name: 'Проекты' }).first().click({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page
      .getByRole('button', { name: new RegExp(PROJECT.name) })
      .first()
      .click({ timeout: 10_000 });
    await page.getByRole('button', { name: MENU_LABEL }).first().waitFor({ timeout: 10_000 });
    // Группа dev-сервера встаёт последней (в сценарии slow — через 2,5 с).
    await page.getByRole('button', { name: RUNNER_NAME }).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1200);
  } catch (error) {
    const [first] = String(error.message).split(/\r?\n/);
    stand.failed = first;
  }
  stand.ready = true;
  stand.touched = Boolean(stand.failed);
  return { page, errors, stand };
}

/**
 * Замер панели: элементы управления (button/select/a без вложенных) внутри
 * самого узкого предка, где есть и «Агенты», и «Настройки чата».
 */
function measureBar(menuLabel) {
  const menu = [...document.querySelectorAll('button')].find(
    (node) =>
      node.textContent?.trim() === menuLabel || node.getAttribute('aria-label') === menuLabel,
  );
  if (!menu) return { error: 'нет кнопки меню чата' };
  // Вся шапка: и ряд разговора (Агенты), и ряд проекта (кнопка dev-сервера).
  const has = (node, test) => [...node.querySelectorAll('button')].some(test);
  const isAgents = (b) => /Агенты/.test(b.textContent ?? '');
  const isRunner = (b) =>
    b.getAttribute('aria-label') === 'Настройки запуска' || b.textContent?.trim() === 'Dev-сервер';
  let bar = menu.parentElement;
  while (bar && !(has(bar, isAgents) && has(bar, isRunner))) bar = bar.parentElement;
  if (!bar) return { error: 'нет ряда с «Агенты»' };
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
  };
  const leaves = [...bar.querySelectorAll('button, select, a[href]')].filter(
    (node) =>
      visible(node) &&
      !node.closest('[role="dialog"]') &&
      !node.parentElement?.closest('button, a[href]'),
  );
  const barRect = bar.getBoundingClientRect();
  // Черта между группами: у группы, открывающей строку, её быть не должно, у
  // остальных — должна. Строку считаем сами, по рамкам, а не по метке кода.
  const rowsOfGroups = [...bar.querySelectorAll('[role="group"]')];
  const separators = [];
  for (const row of rowsOfGroups) {
    let lineTop;
    for (const group of row.children) {
      if (!visible(group)) continue;
      const top = group.getBoundingClientRect().top;
      const starts = lineTop === undefined || top > lineTop + 2;
      if (starts) lineTop = top;
      const mark = getComputedStyle(group, '::before').content;
      const hasLine = mark !== 'none' && mark !== 'normal';
      const label = (group.textContent ?? '').trim().slice(0, 16) || 'группа';
      if (starts && hasLine) separators.push(`черта в начале строки у «${label}»`);
      if (!starts && !hasLine) separators.push(`нет черты перед «${label}»`);
    }
  }
  return {
    groups: rowsOfGroups.length,
    separators,
    vw: window.innerWidth,
    bar: { left: barRect.left, right: barRect.right, top: barRect.top, bottom: barRect.bottom },
    controls: leaves.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        name: (node.getAttribute('aria-label') || node.textContent || node.tagName)
          .trim()
          .slice(0, 30),
        tag: node.tagName.toLowerCase(),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: Math.round(rect.height * 10) / 10,
        mid: Math.round(((rect.top + rect.bottom) / 2) * 10) / 10,
        font: getComputedStyle(node).fontSize,
      };
    }),
  };
}

/** Щелчок-проба: что лежит сверху в точках поповера помеченной кнопки. */
function probePopover() {
  let scope = document.querySelector('[data-qa-trigger]');
  while (scope && !scope.querySelector('[role="dialog"]')) scope = scope.parentElement;
  const dialog = scope?.querySelector('[role="dialog"]');
  if (!dialog) return { error: 'поповер не открылся' };
  const rect = dialog.getBoundingClientRect();
  const firstText = [...dialog.querySelectorAll('*')].find(
    (node) =>
      node.children.length === 0 &&
      (node.textContent ?? '').trim().length > 0 &&
      node.getBoundingClientRect().height > 0,
  );
  const textRect = firstText?.getBoundingClientRect();
  const inset = 6;
  const points = [
    ['левый верхний угол', rect.left + inset, rect.top + inset],
    ['правый верхний угол', rect.right - inset, rect.top + inset],
    ['середина', (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
    ['левый нижний угол', rect.left + inset, rect.bottom - inset],
    ['правый нижний угол', rect.right - inset, rect.bottom - inset],
  ];
  if (textRect) {
    points.push([
      `первая строка «${firstText.textContent.trim().slice(0, 20)}»`,
      textRect.left + Math.min(8, textRect.width / 2),
      (textRect.top + textRect.bottom) / 2,
    ]);
  }
  const covered = points
    .filter(([, x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || !dialog.contains(hit);
    })
    .map(([name, x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return `${name} (сверху ${hit?.tagName.toLowerCase()}.${String(hit?.className).slice(0, 30)})`;
    });
  return {
    rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    vw: window.innerWidth,
    vh: window.innerHeight,
    covered,
  };
}

/** Значок кнопки — по разметке svg, подпись — по имени и подсказке. */
function triggerLook(labels) {
  const node = [...document.querySelectorAll('button')].find((b) =>
    labels.some(
      (label) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
    ),
  );
  if (!node) return undefined;
  return {
    svg: node.querySelector('svg')?.innerHTML ?? '',
    text: node.textContent?.trim() ?? '',
    title: node.getAttribute('title') ?? '',
  };
}

const spread = (values) => Math.max(...values) - Math.min(...values);

async function barChecks(page, tag) {
  // Стенд мог перезагрузить страницу после открытия — ждём шапку заново.
  await page.getByRole('button', { name: MENU_LABEL }).first().waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: RUNNER_NAME }).first().waitFor({ timeout: 10_000 });
  const bar = await page.evaluate(measureBar, MENU_LABEL);
  if (bar.error) {
    check(false, `${tag}: ${bar.error}`);
    return;
  }
  const { controls } = bar;
  const heights = controls.map((c) => c.height);
  check(
    spread(heights) <= 1,
    `${tag}: высота элементов панели одна (${controls.length} шт.: ${[...new Set(heights)].join('/')} px)`,
  );
  // Ряды: элементы, чьи рамки пересекаются по вертикали, стоят в одном ряду.
  const rows = [];
  for (const control of [...controls].sort((a, b) => a.top - b.top)) {
    const row = rows.find((r) => control.top < r.bottom - 4 && control.bottom > r.top + 4);
    if (row) {
      row.items.push(control);
      row.bottom = Math.max(row.bottom, control.bottom);
    } else rows.push({ top: control.top, bottom: control.bottom, items: [control] });
  }
  const offAxis = rows.filter((row) => spread(row.items.map((c) => c.mid)) > 1);
  check(
    offAxis.length === 0,
    `${tag}: в каждом ряду одна средняя линия (рядов ${rows.length}${
      offAxis.length
        ? `; вразнобой: ${offAxis.map((r) => r.items.map((c) => `${c.name}@${c.mid}`).join(', ')).join(' | ')}`
        : ''
    })`,
  );
  check(
    bar.groups > 0 && bar.separators.length === 0,
    `${tag}: группы панели разделены чертой, у начала строки черты нет (рядов групп ${bar.groups}${
      bar.separators.length ? `; ${bar.separators.join(', ')}` : ''
    })`,
  );
  const fonts = [...new Set(controls.map((c) => c.font))];
  check(fonts.length === 1, `${tag}: один кегль у всех элементов (${fonts.join(', ')})`);
  const outside = controls.filter((c) => c.left < -0.5 || c.right > bar.vw + 0.5);
  check(
    outside.length === 0,
    `${tag}: ничего не выходит за край окна${outside.length ? ` (${outside.map((c) => c.name).join(', ')})` : ''}`,
  );
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) overlaps.push(`${a.name} / ${b.name}`);
    }
  }
  check(
    overlaps.length === 0,
    `${tag}: элементы не наезжают друг на друга${overlaps.length ? ` (${overlaps.join(', ')})` : ''}`,
  );
}

async function popoverChecks(page, tag, shot) {
  const runner = await page.evaluate(triggerLook, RUNNER_NAMES);
  const menu = await page.evaluate(triggerLook, [MENU_LABEL]);
  check(Boolean(runner), `${tag}: кнопка настроек dev-сервера есть`);
  if (!runner || !menu) return;
  check(
    runner.svg !== menu.svg,
    `${tag}: значок настроек запуска не тот же, что у «${MENU_LABEL}»`,
  );
  check(
    runner.text.length > 0 && runner.text !== menu.text,
    `${tag}: у кнопки настроек запуска своя видимая подпись («${runner.text}»)`,
  );

  for (const popover of POPOVERS) {
    const name = `${tag} «${popover.title}»`;
    const trigger = page.getByRole('button', { name: popover.name }).first();
    if ((await trigger.count()) === 0) {
      check(false, `${name}: кнопки нет`);
      continue;
    }
    await trigger.evaluate((node) => node.setAttribute('data-qa-trigger', ''), undefined, {
      timeout: 5000,
    });
    await trigger.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const probe = await page.evaluate(probePopover);
    if (probe.error) {
      check(false, `${name}: ${probe.error}`);
    } else {
      const { rect } = probe;
      const inside =
        rect.left >= 0 && rect.top >= 0 && rect.right <= probe.vw && rect.bottom <= probe.vh;
      check(
        inside,
        `${name}: поповер целиком в окне (${Math.round(rect.left)},${Math.round(rect.top)} – ${Math.round(rect.right)},${Math.round(rect.bottom)} при ${probe.vw}x${probe.vh})`,
      );
      check(
        probe.covered.length === 0,
        `${name}: поповер поверх всего${probe.covered.length ? `; закрыто: ${probe.covered.join('; ')}` : ''}`,
      );
    }
    if (shotsTag && RUNNER_NAME.test(popover.title)) {
      await page.screenshot({ path: join(SHOTS, `${shot}-popover_${shotsTag}.png`) });
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const state = await trigger.evaluate(
      (node) => {
        node.removeAttribute('data-qa-trigger');
        return {
          closed: node.getAttribute('aria-expanded') !== 'true',
          focused: document.activeElement === node,
        };
      },
      undefined,
      { timeout: 5000 },
    );
    check(state.closed && state.focused, `${name}: Escape закрыл поповер и вернул фокус на кнопку`);
    // Не закрылся — снимаем щелчком по подложке, иначе следующая кнопка под ней.
    if (!state.closed) await page.mouse.click(2, 2);
  }
}

const scenarios = [
  { width: 1280, height: 900, live: false },
  { width: 400, height: 860, live: false, slow: true },
  { width: 768, height: 900, live: true },
  { width: 1280, height: 900, live: true },
  { width: 1920, height: 1000, live: true },
];

const ATTEMPTS = 3;

for (const theme of ['light', 'dark']) {
  for (const scenario of scenarios) {
    const tag = `[${theme} ${scenario.width}${scenario.live ? ' сервер поднят' : ''}]`;
    const name = `${theme}-${scenario.width}${scenario.live ? '-live' : ''}`;
    // QA_SCENARIO=light-400 — один сценарий (прогон мутантов не ждёт все десять).
    if (process.env.QA_SCENARIO && !process.env.QA_SCENARIO.split(',').includes(name)) continue;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      pending = [];
      const { page, errors, stand } = await openProject({ theme, ...scenario });
      try {
        if (stand.failed) throw new Error(`вкладка проекта не открылась: ${stand.failed}`);
        if (shotsTag) {
          await page.screenshot({ path: join(SHOTS, `${name}-bar_${shotsTag}.png`) });
        }
        await barChecks(page, tag);
        await popoverChecks(page, tag, name);
        check(
          errors.length === 0,
          `${tag}: ошибок страницы нет${errors.length ? ` (${errors.join(' | ')})` : ''}`,
        );
      } catch (error) {
        const [first] = String(error.message).split(/\r?\n/);
        check(false, `${tag}: прогон упал — ${first}`);
      }
      await page.close();
      if (stand.touched && attempt < ATTEMPTS) {
        console.log(`…   ${tag}: стенд перезагрузил модули посреди прогона — повтор`);
        continue;
      }
      flush();
      break;
    }
  }
}

await browser.close();
console.log(bad === 0 ? 'Верхняя панель чата ровная, поповер запуска на виду' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
