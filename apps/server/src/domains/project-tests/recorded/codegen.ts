import type { BrowseGap, BrowseStep, BrowseTarget } from '@agentdeck/contracts/core/browse';
import type { ProjectTestStep } from '@agentdeck/contracts';
import type { RecordedBuild, RecordedItem, RecordedSpecInput } from './recorded.types.ts';

/**
 * Спек записанного прохода (R3, 08d P179): чистая функция строк журнала `browse.step` /
 * `browse.gap`. Ни часов, ни случайных чисел, ни id задачи: те же строки дают тот же спек
 * байт в байт, и перезапись из того же прохода не даёт диффа. Значение секрета сюда не приходит
 * вовсе — спек читает его из `process.env.<ИМЯ>` в момент прогона.
 *
 * Спек — самостоятельный скрипт на библиотеке `playwright` (не `@playwright/test`): прогон блока
 * «Тесты» зовёт его через `junit-run.mjs` как любую проверку с кодом выхода, раннер тестов в
 * проекте для этого не нужен. Код 0 — все шаги прошли, 1 — первый упавший шаг (`✗ шаг N: …`),
 * 2 — «не проверено» (нет доступа стенда, пакета или Chromium).
 */

/** Окончание файла записанного спека: по нему `junit-run` и `tests-cli` узнают такой файл. */
export const RECORDED_SUFFIX = '.recorded.mjs';

/** Строка-метка: спек объявляет о себе полное имя теста, кейс ссылается на него буква в букву. */
export const RECORDED_MARK = '// recorded-test: ';

/** Префикс имени теста записанного прохода. */
export const RECORDED_PREFIX = 'recorded > ';

/** Подпись в шагах кейса и спека — коротко: полное значение живёт в самом спеке. */
const TITLE_VALUE_MAX = 80;

const GAP_TITLES: Record<BrowseGap['action'], string> = {
  hover: 'наведение',
  drag: 'перетаскивание',
  'file-pick': 'выбор файла',
  other: 'действие вне умений прохода',
};

/** Название кейса → полное имя теста: одна строка, без лишних пробелов. */
export function recordedTestName(title: string): string {
  return `${RECORDED_PREFIX}${oneLine(title)}`;
}

/** Путь спека от корня проекта. */
export function recordedFile(groupId: string, caseId: string): string {
  return `.agent/tests/recorded/${groupId}/${caseId}${RECORDED_SUFFIX}`;
}

/** Собрать спек и шаги кейса из строк прохода. */
export function buildRecorded(input: RecordedSpecInput): RecordedBuild {
  const items = orderedItems(input.steps, input.gaps);
  const origin = originOf(input.steps);
  const playable = items.flatMap((item) => (item.kind === 'play' ? [item.playable] : []));
  const caseSteps: ProjectTestStep[] = items.map((item) => caseStepOf(item));
  return {
    spec: specText(input.testName, origin, items),
    origin,
    playable,
    caseSteps,
    unchecked: items.length - playable.length,
  };
}

/**
 * Строки по порядку журнала. У пробела нет номера шага, но id обеих строк — uuidv7, он растёт со
 * временем записи: сортировка по id ставит пробел туда, где модель на него наткнулась.
 * Снимок страницы (`snapshot`) — чтение для модели, а не проверка: в спек он не идёт.
 */
function orderedItems(steps: readonly BrowseStep[], gaps: readonly BrowseGap[]): RecordedItem[] {
  const rows = [
    ...steps.filter((step) => step.action !== 'snapshot').map((step) => ({ step })),
    ...gaps.map((gap) => ({ gap })),
  ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const items: RecordedItem[] = [];
  let n = 0;
  for (const row of rows) {
    if ('gap' in row) {
      items.push({ kind: 'gap', gap: row.gap, title: gapTitle(row.gap) });
    } else if (row.step.ok) {
      n += 1;
      items.push({ kind: 'play', playable: { n, title: stepTitle(row.step), step: row.step } });
    } else {
      items.push({ kind: 'failed', step: row.step, title: stepTitle(row.step) });
    }
  }
  return items;
}

/** Ключ порядка: id строки (uuidv7), у шагов с равным id — их номер. */
function keyOf(row: { step: BrowseStep } | { gap: BrowseGap }): string {
  if ('gap' in row) return row.gap.stepId;
  return `${row.step.stepId}:${String(row.step.n).padStart(6, '0')}`;
}

/** Адрес стенда записи — источник первой строки с адресом. */
function originOf(steps: readonly BrowseStep[]): string {
  for (const step of steps) {
    for (const raw of [step.action === 'open' ? step.value : undefined, step.url]) {
      const origin = safeOrigin(raw);
      if (origin) return origin;
    }
  }
  return 'http://127.0.0.1';
}

function safeOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Адрес своего стенда — путём от корня: тот же спек гоняется на другом адресе (`E2E_BASE_URL`). */
function pathOn(origin: string, raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : raw;
  } catch {
    return raw;
  }
}

function caseStepOf(item: RecordedItem): ProjectTestStep {
  if (item.kind === 'play') {
    const { n, title, step } = item.playable;
    return step.action === 'expect'
      ? { action: `Шаг ${n}. Проверить: ${title}`, expected: title }
      : { action: `Шаг ${n}. ${title}` };
  }
  if (item.kind === 'gap') {
    return { action: `Не проверено: ${item.title}`, expected: 'проход это не умеет — шаг вручную' };
  }
  return {
    action: `Не проверено: ${item.title}`,
    expected: 'при записи шаг не прошёл — в спек не вошёл',
  };
}

function short(value: string): string {
  const line = oneLine(value);
  return line.length > TITLE_VALUE_MAX ? `${line.slice(0, TITLE_VALUE_MAX)}…` : line;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function targetTitle(target: BrowseTarget | undefined): string {
  if (!target) return 'страницу';
  if ('role' in target) return `${target.role} «${short(target.name)}»`;
  if ('testId' in target) return `элемент data-testid «${short(target.testId)}»`;
  if ('label' in target) return `поле «${short(target.label)}»`;
  return `текст «${short(target.text)}»`;
}

/** Подпись шага по-русски — она же в выводе спека (`✓ шаг N: …`) и в шаге кейса. */
export function stepTitle(step: BrowseStep): string {
  const target = targetTitle(step.target);
  const value = short(step.value ?? '');
  switch (step.action) {
    case 'open':
      return `открыть ${short(step.value ?? step.url)}`;
    case 'click':
      return `нажать ${target}`;
    case 'fill':
      return step.secret
        ? `ввести доступ ${step.secret.name} в ${target}`
        : `ввести «${value}» в ${target}`;
    case 'press':
      return step.target ? `нажать клавишу ${value} в ${target}` : `нажать клавишу ${value}`;
    case 'select':
      return `выбрать «${value}» в ${target}`;
    default:
      return expectTitle(step, target, value);
  }
}

function expectTitle(step: BrowseStep, target: string, value: string): string {
  if (step.expect === 'hidden') return `скрыто ${target}`;
  if (step.expect === 'text') return `в ${target} текст «${value}»`;
  if (step.expect === 'value') return `в ${target} значение «${value}»`;
  if (step.expect === 'url') return `адрес страницы ${value}`;
  return `видно ${target}`;
}

function gapTitle(gap: BrowseGap): string {
  const where = gap.target ? ` ${targetTitle(gap.target)}` : '';
  return `${GAP_TITLES[gap.action]}${where} — ${short(gap.why)}`;
}

const q = (value: string | string[]): string => JSON.stringify(value);

/** Локатор цели — тот же поиск, что у ядра при проходе (`exact: true`), буква в букву. */
function locatorCode(target: BrowseTarget | undefined): string {
  if (!target) return 'page.locator("body")';
  if ('role' in target)
    return `page.getByRole(${q(target.role)}, { name: ${q(target.name)}, exact: true })`;
  if ('testId' in target) return `page.getByTestId(${q(target.testId)})`;
  if ('label' in target) return `page.getByLabel(${q(target.label)}, { exact: true })`;
  return `page.getByText(${q(target.text)}, { exact: true })`;
}

/** Строки тела шага спека. */
function bodyOf(step: BrowseStep, origin: string): string[] {
  const at = locatorCode(step.target);
  const value = step.value ?? '';
  switch (step.action) {
    case 'open':
      return [`await page.goto(at(${q(pathOn(origin, step.value ?? step.url))}));`];
    case 'click':
      return [`await ${at}.click();`];
    case 'fill':
      // Секрет — только по имени: значение подставит окружение прогона, в файле его нет; набирается
      // лишь на странице своего стенда (`fillSecret`).
      return step.secret
        ? [`await fillSecret(${at}, ${q(step.secret.name)});`]
        : [`await ${at}.fill(${q(value)});`];
    case 'press':
      return step.target
        ? [`await ${at}.press(${q(value)});`]
        : [`await page.keyboard.press(${q(value)});`];
    case 'select':
      return [`await ${at}.selectOption(${q(value)});`];
    default:
      return expectBody(step, at, origin);
  }
}

function expectBody(step: BrowseStep, at: string, origin: string): string[] {
  const value = step.value ?? '';
  if (step.expect === 'hidden') return [`await ${at}.waitFor({ state: "hidden" });`];
  if (step.expect === 'text') {
    return [
      `await until(async () => squash(await ${at}.innerText()).includes(${q(oneLine(value))}), ${q(stepTitle(step))});`,
    ];
  }
  if (step.expect === 'value') {
    return [
      `await until(async () => (await ${at}.inputValue()) === ${q(value)}, ${q(stepTitle(step))});`,
    ];
  }
  if (step.expect === 'url') {
    const path = pathOn(origin, value);
    // Свой стенд — точный адрес на текущем стенде; кусок адреса — вхождение.
    return safeOrigin(value)
      ? [`await until(() => page.url() === at(${q(path)}), ${q(stepTitle(step))});`]
      : [`await until(() => page.url().includes(${q(value)}), ${q(stepTitle(step))});`];
  }
  return [`await ${at}.waitFor({ state: "visible" });`];
}

/** Имена доступов стенда, которые спек читает из окружения, — по порядку первого появления. */
function secretNames(items: readonly RecordedItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    const name = item.kind === 'play' ? item.playable.step.secret?.name : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function specText(testName: string, origin: string, items: readonly RecordedItem[]): string {
  const lines: string[] = [
    `${RECORDED_MARK}${testName}`,
    '// Записано панелью из прохода ядра по стенду. Руками не правится: устарел — перезапишите',
    '// кейс из нового прохода. Адрес стенда — E2E_BASE_URL, доступы — переменные окружения прогона.',
    `const BASE = process.env.E2E_BASE_URL || ${q(origin)};`,
    `const SECRETS = ${q(secretNames(items))};`,
    'const STEPS = [',
  ];
  for (const item of items) {
    if (item.kind !== 'play') {
      lines.push(`  // Не проверено: ${item.title.replace(/\*\//g, '* /')}`);
      continue;
    }
    const { n, title, step } = item.playable;
    lines.push(`  [${n}, ${q(title)}, async () => {`);
    for (const line of bodyOf(step, origin)) lines.push(`    ${line}`);
    lines.push('  }],');
  }
  lines.push('];', '', RUNTIME);
  return `${lines.join('\n')}\n`;
}

/** Исполнитель спека — неизменный текст: вся запись живёт в `STEPS` выше. */
const RUNTIME = `const TIMEOUT = Number(process.env.RECORDED_STEP_TIMEOUT_MS) || 10000;
let page;

function at(path) {
  return new URL(path, BASE).href;
}

function squash(text) {
  return String(text).replace(/\\s+/g, " ").trim();
}

function firstLine(error) {
  return String(error?.message ?? error).split("\\n")[0];
}

async function until(check, what) {
  const end = Date.now() + TIMEOUT;
  for (;;) {
    let last;
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error("не дождался: " + what + (last ? " (" + firstLine(last) + ")" : ""));
    await new Promise((done) => setTimeout(done, 200));
  }
}

// Доступ привязан к адресу окружения (как у прохода ядра): стенд увёл на чужой адрес — шаг встаёт
// с именем доступа, значение туда не набирается. Нет значения — тоже по имени, не «undefined».
async function fillSecret(locator, name) {
  const here = new URL(page.url()).origin;
  const own = new URL(BASE).origin;
  if (here !== own) throw new Error("доступ " + name + " не для этой страницы: " + here + " — он только для " + own);
  const value = process.env[name];
  if (!value) throw new Error("нет значения доступа " + name);
  try {
    await locator.fill(value);
  } catch (error) {
    // Журнал вызова в ошибке Playwright несёт набранное значение (fill("…")) — наружу идёт только маска.
    throw new Error(String(error?.message ?? error).split(value).join("••••••"));
  }
}

function notChecked(why) {
  console.log("Не проверено. " + why);
  process.exitCode = 2;
}

async function loadPlaywright() {
  for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
    try {
      const loaded = await import(name);
      const chromium = loaded.chromium ?? loaded.default?.chromium;
      if (chromium) return chromium;
    } catch {
      // Нет этого пакета — следующий.
    }
  }
  return undefined;
}

async function main() {
  const missing = SECRETS.filter((name) => !process.env[name]);
  if (missing.length > 0) return notChecked("нет доступов стенда: " + missing.join(", ") + " — прогон с --env <окружение>.");
  const chromium = await loadPlaywright();
  if (!chromium) return notChecked("нет пакета playwright в проекте: npm i -D playwright.");
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    return notChecked("Chromium не запустился: " + firstLine(error) + " — npx playwright install chromium.");
  }
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    for (const [n, title, run] of STEPS) {
      try {
        await run();
      } catch (error) {
        console.log("✗ шаг " + n + ": " + title);
        console.log("  " + firstLine(error));
        process.exitCode = 1;
        return;
      }
      console.log("✓ шаг " + n + ": " + title);
    }
    console.log("Все шаги пройдены: " + STEPS.length + ".");
  } finally {
    await browser.close();
  }
}

await main();
`;
