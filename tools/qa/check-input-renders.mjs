/**
 * Перерисовки на ввод: сколько компонентов React перерисовывает одно нажатие
 * клавиши в поле — по всем разделам панели (`PANEL_PAGES`).
 *
 * Жалоба людей — «страница мигает, пока печатаю»: черновик композера жил в
 * состоянии всей страницы чата, и каждая буква перерисовывала боковую панель,
 * шапку и всю ленту. Считается это не чтением кода, а самим React: до загрузки
 * страницы ставится крючок инструментов разработчика
 * (`__REACT_DEVTOOLS_GLOBAL_HOOK__`), React отдаёт ему каждое дерево после
 * коммита, а крючок отмечает компоненты, отработавшие в этом коммите.
 *
 * «Отработал» = объект волокна новый для этого коммита И несёт флаг
 * PerformedWork. Узел, который React не трогал, остаётся ТЕМ ЖЕ объектом, что
 * в прошлом дереве, и его старый флаг не считается; узел, прошедший через
 * рендер, — это его второй буфер, другой объект.
 *
 * Записи на сервер в прогоне отрезаны: любой запрос к API, кроме GET,
 * обрывается — поле с автосохранением не тронет настоящий `~/.claude`.
 *
 * Провал: поле перерисовывает на букву компонент из `FAR` (части страницы,
 * которым до черновика дела нет) или больше `BUDGET` компонентов сверх фона
 * (сколько страница перерисовывает сама, без ввода, за то же время).
 *
 *   node tools/qa/check-input-renders.mjs [--only <фрагмент пути>] [--verbose]
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { PANEL_PAGES, openPanelPage } from './panel-pages.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const verbose = args.includes('--verbose');

/** Компонентов на одно нажатие сверх фона — больше уже перерисовка страницы, а не поля. */
// Порог с запасом от обеих сторон, замерено 12.10.2026 на живых данных: утечки
// давали 170–420 (чат, «Тестирование», правила защиты данных), поле со своим
// контейнером — до 80 (пульт прогона, строка правила с шапкой страницы).
const BUDGET = Number(process.env.RENDER_BUDGET ?? 100);
/**
 * Части страницы, которые не зависят от текста поля: их перерисовка на букву —
 * утечка, сколько бы её ни было.
 */
const FAR = [
  'ChatSidebar',
  'ChatHeader',
  'ChatThread',
  'ChatMessage',
  'ProjectTabs',
  'AppSidebar',
  'Sidebar',
  'NavItem',
  'Header',
];
/**
 * Чат с открытым проектом: композер есть только там, а в общем списке разделов
 * чат открыт либо без проекта, либо под окном git. Проект — сам репозиторий
 * панели: в нём есть транскрипты, значит, есть лента, которую буква не должна
 * трогать.
 */
const CHAT_WITH_PROJECT = {
  path: '/chat',
  name: 'Чат — проект открыт',
  prepare: async (page) => {
    await page.evaluate((path) => {
      // Ключ вкладки, как `normalizeProjectPath` фронта: регистр — только у путей Windows.
      const flat = path.replace(/\\/g, '/').replace(/\/+$/, '');
      const id = /^[A-Za-z]:([\\/]|$)|^\\\\/.test(path) ? flat.toLowerCase() : flat;
      localStorage.setItem(
        'agentdeck:workspace',
        JSON.stringify({ projectTabs: [{ id, path, name: 'qa' }], activeTabId: id, views: {} }),
      );
    }, process.env.QA_CHAT_PROJECT || process.cwd());
  },
  ready: 'main textarea',
};

/** Сколько полей раздела проверять: первые видимые. */
const FIELDS_PER_PAGE = 4;
/** Букв на поле; первая не считается — она открывает поле (фокус, подсказки). */
const KEYS = 'abcdef';
/** Сколько ждать хвост коммитов после буквы. */
const SETTLE_MS = 180;

/** Ставится до кода страницы: крючок, который считает отработавшие компоненты. */
function installHook() {
  const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
  const PERFORMED_WORK = 1;
  let previous = new WeakSet();
  const tally = new Map();
  // Корни перерисовки: отработавший компонент, чей ближайший компонент-предок
  // в этом коммите не работал, — там и живёт состояние, которое двинула буква.
  const roots = new Map();
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (!type) return 'Anonymous';
    if (fiber.tag === 11)
      return type.displayName || type.render?.displayName || type.render?.name || 'ForwardRef';
    return type.displayName || type.name || 'Anonymous';
  };
  const walk = (root) => {
    const seen = new WeakSet();
    const rendered = new WeakSet();
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      seen.add(fiber);
      if (
        COMPONENT_TAGS.has(fiber.tag) &&
        !previous.has(fiber) &&
        (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK
      ) {
        const name = nameOf(fiber);
        tally.set(name, (tally.get(name) ?? 0) + 1);
        rendered.add(fiber);
        let parent = fiber.return;
        while (parent && !COMPONENT_TAGS.has(parent.tag)) parent = parent.return;
        if (!parent || !rendered.has(parent)) roots.set(name, (roots.get(name) ?? 0) + 1);
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    previous = seen;
  };
  let nextId = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    inject(renderer) {
      nextId += 1;
      this.renderers.set(nextId, renderer);
      return nextId;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      walk(root);
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
  };
  window.__renderTally = {
    reset: () => {
      tally.clear();
      roots.clear();
    },
    read: () => Object.fromEntries(tally),
    roots: () => Object.fromEntries(roots),
  };
}

const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
const top = (counts, n = 8) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');

/** Видимые поля текста в разделе, без отключённых и только-для-чтения. */
async function fieldsOf(page) {
  const locator = page.locator(
    'main textarea, main input:not([type]), main input[type="text"], main input[type="search"], main input[type="url"], main input[type="email"], main [contenteditable="true"]',
  );
  const out = [];
  for (const field of await locator.all()) {
    if (out.length >= FIELDS_PER_PAGE) break;
    if (!(await field.isVisible().catch(() => false))) continue;
    if (!(await field.isEditable().catch(() => false))) continue;
    out.push(field);
  }
  return out;
}

async function labelOf(field) {
  return field.evaluate((el) =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.tagName.toLowerCase()
    )
      .trim()
      .slice(0, 48),
  );
}

/** Отработавшие компоненты за окно `SETTLE_MS` после действия. */
async function measure(page, action) {
  await page.evaluate(() => window.__renderTally.reset());
  await action();
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(() => ({
    counts: window.__renderTally.read(),
    roots: window.__renderTally.roots(),
  }));
}

/** Что сейчас в поле: ввод мог уйти не туда (окно поверх раздела забрало фокус). */
const valueOf = (field) =>
  field.evaluate((el) => ('value' in el ? el.value : el.textContent) ?? '');

const failures = [];
const rows = [];

const browser = await chromium.launch();
try {
  // Без `interact`: он открывает окна поверх раздела, а поля проверяются в самом разделе.
  const pages = [...PANEL_PAGES, CHAT_WITH_PROJECT].map(({ interact: _skip, ...entry }) => entry);
  for (const entry of pages) {
    if (only && !entry.path.includes(only) && !(entry.name ?? '').includes(only)) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(installHook);
    await bypassOnboarding(page);
    // Зарегистрирован последним — значит, спрошен первым: запись не уходит никуда.
    await page.route('**/api/**', (route) =>
      route.request().method() === 'GET' ? route.fallback() : route.abort(),
    );
    try {
      await openPanelPage(page, BASE, entry);
      const hooked = await page.evaluate(() => Boolean(window.__renderTally));
      if (!hooked) throw new Error('крючок React не встал');
      const fields = await fieldsOf(page);
      for (const field of fields) {
        const label = await labelOf(field);
        await field.click();
        await page.keyboard.type(KEYS[0]);
        await page.waitForTimeout(400);
        const idle = (await measure(page, async () => undefined)).counts;
        const measured = [];
        for (const key of KEYS.slice(1)) {
          measured.push(await measure(page, () => page.keyboard.type(key)));
        }
        const typed = await valueOf(field);
        const perKey = measured.map((item) => item.counts);
        // Поле — назад к пустому: черновик не переживёт контекст, но страница
        // дальше не должна видеть мусор.
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        if (!typed.includes(KEYS)) {
          failures.push(
            `${entry.name ?? entry.path} · «${label}»: ввод не дошёл до поля (в нём «${typed.slice(0, 40)}»)`,
          );
          continue;
        }
        const sorted = perKey.map(total).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const medianRoots = measured.find((item) => total(item.counts) === median)?.roots ?? {};
        const worst = perKey.reduce((a, b) => (total(b) > total(a) ? b : a));
        // Дальняя часть, задетая ОДНОЙ буквой из пяти, — скорее фоновый опрос,
        // совпавший с нажатием; утечка повторяется на каждой букве.
        const far = FAR.filter(
          (name) =>
            perKey.filter((counts) => name in counts).length >= Math.ceil(perKey.length / 2),
        );
        const over = median - total(idle);
        const row = `${entry.name ?? entry.path} · «${label}»: ${median} на букву (фон ${total(idle)}), от ${Object.keys(medianRoots).join(', ') || '—'}`;
        const detail = `${verbose ? ` [${perKey.map(total).join(' ')}]` : ''}${verbose || far.length || over > BUDGET ? `\n      ${top(worst)}` : ''}`;
        rows.push(`${row}${detail}`);
        if (far.length) failures.push(`${row} — перерисованы ${far.join(', ')}`);
        else if (over > BUDGET) failures.push(`${row} — больше ${BUDGET} сверх фона`);
      }
      if (!fields.length && verbose) rows.push(`${entry.name ?? entry.path}: полей нет`);
    } catch (error) {
      failures.push(
        `${entry.name ?? entry.path}: ${String(error?.message ?? error).split('\n')[0]}`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

for (const row of rows) console.log(`  ${row}`);
console.log(`\nПолей проверено: ${rows.filter((row) => row.includes('«')).length}`);
if (failures.length) {
  console.log(`\nПровалов: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('Провалов: 0');
