/**
 * Переход агента панели попадает туда, где элемент действительно виден, и
 * страница показывает то, что записал агент (ревью 28.09: F-79, F-80, F-81, F-95, F-285).
 *
 * - Правило DLP открывается на вкладке правил, правило — на «Все», группа — на
 *   вкладке своей области (проектная — «В проектах», половина пары — карточка
 *   глобальной копии), хотя в памяти зрителя стоит другая вкладка. Незнакомая
 *   группа адрес не засоряет и вкладку не трогает.
 * - /dlp без правок человека показывает правила, которые записал агент, и не
 *   горит «не сохранено»; с правками человека — черновик цел и сказано, что
 *   правила изменились в другом месте.
 * - Подпись проекта в окне агента следует за выбором на странице тестов.
 * - Карточка интеграции показывается, а фокус не уходит в её поле настроек (F-285).
 *
 * API агента, DLP, правил и групп подменены; любая иная запись (не GET) до
 * сервера не доходит — прогон не трогает конфигурацию человека. Реестр проектов
 * читается со стенда как есть (только чтение).
 *
 * Запуск: `node tools/qa/check-agent-focus-tabs.mjs` при поднятом `pnpm dev`
 * (`APP_URL`, по умолчанию http://localhost:8888). `--only dlp-draft,dlp-tab,rules-tab,groups-tab,project-label,integration-focus`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { installGroupStubs, makeGroupState } from './group-stubs.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(',')) : undefined;
const wants = (name) => !only || only.has(name);

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

/** Поток `/api/events` подменён: кадры агента шлёт сам прогон. */
const pageStubs = () => {
  const sources = [];
  class QaEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      sources.push(this);
      setTimeout(() => this.onopen?.(new Event('open')), 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = QaEventSource;
  window.__qaEmit = (frame) => {
    for (const source of sources) {
      if (source.readyState === 1 && String(source.url).includes('/api/events')) {
        source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
      }
    }
  };
};

const rule = (id, name, terms) => ({
  id,
  name,
  enabled: true,
  kind: 'terms',
  terms,
  pattern: '',
  action: 'mask',
  label: 'QA',
});

const stub = {
  dlpRules: [rule('qa-a', 'QA правило A', ['alpha'])],
  dlpPuts: [],
  rules: [
    {
      id: 'qa-rule-on',
      title: 'QA включённое',
      body: 'тело',
      order: 0,
      isEnabled: true,
      groupIds: [],
    },
    {
      id: 'qa-rule-off',
      title: 'QA выключенное',
      body: 'тело',
      order: 1,
      isEnabled: false,
      groupIds: [],
    },
  ],
  blockedWrites: [],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(pageStubs);
// Сокет горячей перезагрузки Vite: правка чужого файла на стенде иначе
// перезагружала бы страницу посреди сценария.
const appPort = new URL(BASE).port;
await context.routeWebSocket(
  (url) => url.port === appPort && url.pathname === '/',
  () => undefined,
);
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));

// Последняя поставленная подмена отвечает первой: сторож записи ставится
// первым и видит только то, что прочие отдали дальше.
await page.route('**/api/**', (route) => {
  const request = route.request();
  if (request.method() === 'GET') return route.fallback();
  stub.blockedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
  return route
    .fulfill({ status: 501, json: { error: 'qa: запись закрыта' } })
    .catch(() => undefined);
});
await bypassOnboarding(page);
await installGroupStubs(page, makeGroupState());
await page.route('**/api/agent/**', (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith('/run')) {
    const frames = [
      { kind: 'start', conversationId: 'qa-focus-conv', providerId: 'claude' },
      { kind: 'done', reply: 'ок' },
    ];
    return route
      .fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      })
      .catch(() => undefined);
  }
  if (path.endsWith('/conversations/qa-focus-conv')) {
    return route.fulfill({ status: 404, json: { error: 'not_found' } }).catch(() => undefined);
  }
  return route.fulfill({ json: [] }).catch(() => undefined);
});
await page.route(/\/api\/dlp(\/.*)?(\?.*)?$/, async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === '/api/dlp' && request.method() === 'GET') {
    // Целиком своё: стенд в перезапуске отвечал пустым телом посреди сценария.
    // Встроенных образцов не нужно — правила сценария все словарные.
    return route
      .fulfill({
        json: {
          settings: {
            enabled: false,
            port: 5179,
            upstreamUrl: '',
            upstreamProfileId: '',
            passUnknown: false,
            journal: true,
          },
          rules: stub.dlpRules,
          status: { running: false, address: '', upstream: '', requests: 0, masked: 0, blocked: 0 },
          builtins: [],
        },
      })
      .catch(() => undefined);
  }
  if (path === '/api/dlp/rules' && request.method() === 'PUT') {
    stub.dlpPuts.push(request.postDataJSON());
    return route.fulfill({ json: { ok: true } }).catch(() => undefined);
  }
  return route.fallback();
});
await page.route(/\/api\/rules(\?.*)?$/, (route) =>
  route.request().method() === 'GET'
    ? route.fulfill({ json: stub.rules }).catch(() => undefined)
    : route.fallback(),
);

const emit = (frame) => page.evaluate((f) => window.__qaEmit(f), frame);
const remember = (key, value) =>
  page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [key, value]);
const search = () => Object.fromEntries(new URL(page.url()).searchParams);
/** Якорь найден и показан: фокус внутри или подсветка. */
const shown = (selector) =>
  page
    .waitForFunction(
      (sel) => {
        const element = document.querySelector(sel);
        if (!element) return false;
        return (
          element.hasAttribute('data-agent-highlight') || element.contains(document.activeElement)
        );
      },
      selector,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
const openPage = async (route, focus) => {
  await emit({ type: 'agent-open-page', page: focus ? { route, focus } : { route } });
  await page.waitForURL((url) => url.pathname === route.split('?')[0], { timeout: 10_000 });
};

await page.goto(`${BASE}/`);
await page.locator('[data-panel-agent-trigger]').waitFor({ timeout: 30_000 });

// ── F-81: черновик DLP следует за записью агента, пока человек его не трогал ──
if (wants('dlp-draft')) {
  await page.goto(`${BASE}/dlp?tab=rules`);
  const save = page.getByRole('button', { name: 'Сохранить правила' });
  await save.waitFor({ timeout: 30_000 }).catch(async (error) => {
    console.log(
      (
        await page
          .locator('main')
          .innerText()
          .catch(() => '')
      ).slice(0, 600),
    );
    throw error;
  });
  check(await save.isDisabled(), 'открыто без правок: «Сохранить» недоступна');
  stub.dlpRules = [...stub.dlpRules, rule('qa-b', 'QA правило B', ['beta'])];
  await emit({ type: 'agent-decided', id: 'qa-card', outcome: 'done', section: 'dlp' });
  const rowB = page.locator('[data-agent-anchor="dlp-rule:qa-b"]');
  const appeared = await rowB
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  check(appeared, 'правило, записанное агентом, видно без F5');
  check(
    await save.isDisabled(),
    'после записи агента «не сохранено» не горит (Сохранить недоступна)',
  );
  const tabNote = await page
    .getByRole('tab', { name: /Правила/ })
    .first()
    .innerText();
  check(
    !/не сохран/i.test(tabNote),
    'вкладка правил без метки «не сохранено»',
    tabNote.replace(/\s+/g, ' '),
  );

  // Негатив: человек правит — черновик цел, а о чужой записи сказано.
  await page.getByRole('button', { name: 'Свой словарь' }).click();
  const rowsBefore = await page.locator('[data-agent-anchor^="dlp-rule:"]').count();
  stub.dlpRules = [...stub.dlpRules, rule('qa-c', 'QA правило C', ['gamma'])];
  await emit({ type: 'agent-decided', id: 'qa-card-2', outcome: 'done', section: 'dlp' });
  const warned = await page
    .getByText('Правила изменились вне этой страницы', { exact: false })
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  check(warned, 'правки человека + запись агента: страница говорит, что правила изменились');
  const rowsAfter = await page.locator('[data-agent-anchor^="dlp-rule:"]').count();
  check(
    rowsAfter === rowsBefore,
    `черновик человека не затёрт (${rowsBefore} → ${rowsAfter} строк)`,
  );
  check(!(await save.isDisabled()), 'черновик человека можно сохранить');
  await page.getByRole('button', { name: 'Отменить правки' }).click();
  const fresh = await page
    .locator('[data-agent-anchor="dlp-rule:qa-c"]')
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  check(fresh, '«Отменить правки» показывает правила агента');
  check(stub.dlpPuts.length === 0, 'ни одного сохранения правил за сценарий');
}

// ── F-79: правило DLP — вкладка правил, хотя помнится «Прокси» ──
if (wants('dlp-tab')) {
  stub.dlpRules = [rule('qa-a', 'QA правило A', ['alpha']), rule('qa-b', 'QA правило B', ['beta'])];
  await page.goto(`${BASE}/`);
  await remember('agentdeck.dlp.tab', 'proxy');
  await openPage('/dlp', 'dlp-rule:qa-b');
  check(search().tab === 'rules', 'агент открыл /dlp на вкладке правил', JSON.stringify(search()));
  check(await shown('[data-agent-anchor="dlp-rule:qa-b"]'), 'строка правила DLP показана');
  // Негатив: без якоря вкладка остаётся за человеком.
  await page.goto(`${BASE}/`);
  await remember('agentdeck.dlp.tab', 'journal');
  await openPage('/dlp');
  await page.waitForTimeout(800);
  const selectedTabs = page.getByRole('tab', { selected: true });
  await selectedTabs.first().waitFor({ timeout: 30_000 });
  const selected = await selectedTabs.first().innerText();
  check(/Журнал/.test(selected), 'без якоря открыта запомненная вкладка', selected);
}

// ── F-79: правило — «Все», хотя помнится «Выключены» ──
if (wants('rules-tab')) {
  await page.goto(`${BASE}/`);
  await remember('agentdeck.rules.tab', 'disabled');
  await openPage('/rules', 'qa-rule-on');
  check(search().tab === 'all', 'агент открыл /rules на «Все»', JSON.stringify(search()));
  check(await shown('[data-agent-anchor="qa-rule-on"]'), 'карточка включённого правила показана');
}

// ── F-80: группа — вкладка своей области ──
if (wants('groups-tab')) {
  const selectedTab = () =>
    page
      .getByRole('tablist', { name: /^(Разделы групп|Group sections)$/ })
      .getByRole('tab', { selected: true })
      .innerText();
  await page.goto(`${BASE}/`);
  await remember('agentdeck.groups.tab', 'global');
  await openPage('/groups', 'qa-site-docs');
  check(await shown('[data-agent-anchor="qa-site-docs"]'), 'карточка проектной группы показана');
  check(
    /В проектах/.test(await selectedTab()),
    'открыта вкладка «В проектах»',
    await selectedTab(),
  );
  check(!('show' in search()), '?show= ушёл из адреса', JSON.stringify(search()));

  await page.goto(`${BASE}/`);
  await remember('agentdeck.groups.tab', 'project');
  await openPage('/groups', 'qa-shop-order');
  check(
    await shown('[data-agent-anchor-alias="qa-shop-order"]'),
    'проектная половина пары показана карточкой глобальной копии',
  );
  check(/Глобальн/.test(await selectedTab()), 'пара — на «Глобальных»', await selectedTab());

  // Негатив: незнакомая группа — вкладка человека, адрес чист.
  await page.goto(`${BASE}/`);
  await remember('agentdeck.groups.tab', 'project');
  await openPage('/groups', 'qa-no-such-group');
  await page.waitForTimeout(1_500);
  check(
    /В проектах/.test(await selectedTab()),
    'незнакомая группа: вкладка не тронута',
    await selectedTab(),
  );
  check(
    !('show' in search()),
    'незнакомая группа: ?show= ушёл из адреса',
    JSON.stringify(search()),
  );
}

// ── F-95: подпись проекта в окне агента следует за выбором на /tests ──
if (wants('project-label')) {
  await page.goto(`${BASE}/tests`);
  const picker = page.getByLabel('Проект', { exact: true });
  await picker.waitFor({ timeout: 15_000 });
  const options = await picker
    .locator('option')
    .evaluateAll((items) => items.map((item) => ({ value: item.value, label: item.textContent })));
  if (options.length < 2) {
    check(false, 'в реестре стенда нужно два проекта', String(options.length));
  } else {
    await page.locator('[data-panel-agent-trigger]').click();
    const badge = page.locator('[data-panel-agent-window]').getByText(/^Проект: /);
    await badge.waitFor({ timeout: 8_000 });
    const current = await picker.inputValue();
    const other = options.find((option) => option.value !== current);
    await picker.selectOption(other.value);
    const followed = await page
      .waitForFunction(
        (name) =>
          [...document.querySelectorAll('[data-panel-agent-window] *')].some(
            (node) => node.childElementCount === 0 && node.textContent === `Проект: ${name}`,
          ),
        other.label,
        { timeout: 1_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(followed, `подпись окна агента сменилась на «${other.label}»`, await badge.innerText());
    // Отправка несёт тот же проект, что на подписи.
    const registry = await page.evaluate(() => fetch('/api/projects').then((r) => r.json()));
    const otherPath = registry.find((item) => item.id === other.value)?.path ?? '';
    let sent;
    const onRequest = (request) => {
      if (request.url().endsWith('/api/agent/run')) sent = request.postDataJSON();
    };
    page.on('request', onRequest);
    const input = page.locator('[data-panel-agent-window] [data-agent-input]');
    await input.fill('QA: какой проект?');
    await input.press('Enter');
    await page.waitForTimeout(1_000);
    page.off('request', onRequest);
    const body = JSON.stringify(sent ?? {});
    check(
      otherPath.length > 0 && body.includes(JSON.stringify(otherPath).slice(1, -1)),
      'ход ушёл с проектом с подписи',
      body.slice(0, 200),
    );
    // Вернуть выбор человека: память вкладки тестов — его, а не прогона.
    await picker.selectOption(current);
  }
}

// ── F-285: карточка интеграции показана, а фокус не уходит в её поле ──
if (wants('integration-focus')) {
  await page.goto(`${BASE}/`);
  await emit({
    type: 'agent-open-page',
    page: { route: '/settings?tab=integrations', focus: 'integration:atlassian' },
  });
  await page.waitForURL((url) => url.pathname === '/settings', { timeout: 10_000 });
  const found = await shown('[data-agent-anchor="integration:atlassian"]');
  await page.waitForTimeout(600);
  const active = await page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}` : '';
  });
  check(found, 'якорь интеграции Atlassian показан');
  check(
    !/^(input|select|textarea)/.test(active),
    'фокус не поставлен в поле настроек интеграции',
    active,
  );
  await page
    .screenshot({
      path: `.agent/screenshots/before-after/nits-N3/integration-focus_${process.env.PHASE ?? 'AFTER'}.png`,
    })
    .catch(() => undefined);
}

// ── F-192: режим композера, заказанный агентом, доходит до чата — и один раз ──
// Срок защёлки не должен съесть обычный переход агента: чат открывается следом.
if (wants('composer-mode')) {
  const modeButton = (label) =>
    page.locator('button[aria-haspopup="dialog"]').filter({ hasText: label });
  await page.goto(`${BASE}/skills`);
  await page.locator('[data-panel-agent-trigger]').waitFor({ timeout: 30_000 });
  await openPage('/chat?mode=deck');
  const deck = await modeButton('Презентация')
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(deck, 'агент открыл чат презентации — композер в режиме «Презентация»');
  await page.goto(`${BASE}/skills`);
  await page.locator('[data-panel-agent-trigger]').waitFor({ timeout: 30_000 });
  await openPage('/chat');
  const text = await modeButton('Сообщение')
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check(text, 'следующий чат без заказа — снова «Сообщение», просьба не повторилась');
}

// ── F-239: повторный показ того же права снимает фильтр и докручивает снова ──
if (wants('permissions-repeat')) {
  // Список длиннее порога виртуализации (40): строки вне экрана нет в DOM.
  const permissions = Array.from({ length: 60 }, (_, index) => ({
    id: `allow:QaTool${index}`,
    pattern: `QaTool${index}`,
    decision: 'allow',
    groupIds: [],
    source: 'settings',
    isEnabled: true,
  }));
  await page.route(/\/api\/permissions(\?.*)?$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: permissions }).catch(() => undefined)
      : route.fallback(),
  );
  const target = '[data-agent-anchor="allow:QaTool45"]';
  const searchBox = page.getByRole('searchbox').or(page.getByLabel('Поиск')).first();
  await page.goto(`${BASE}/`);
  await page.locator('[data-panel-agent-trigger]').waitFor({ timeout: 30_000 });
  await openPage('/permissions', 'allow:QaTool45');
  check(await shown(target), 'первый показ: строка права показана');

  // Человек ушёл от строки: отбор по другому праву прячет её из списка.
  await searchBox.fill('QaTool1');
  await page
    .locator(target)
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined);
  check((await page.locator(target).count()) === 0, 'отбор человека спрятал строку');

  // Тот же показ ещё раз — тот же адрес.
  await openPage('/permissions', 'allow:QaTool45');
  check(await shown(target), 'повторный показ того же права: строка снова показана');
  check((await searchBox.inputValue()) === '', 'повторный показ снял отбор человека');

  // Переход самой страницы (редактор права) метки агента не несёт — отбор,
  // набранный после показа, живёт.
  await searchBox.fill('QaTool4');
  // Кнопки действий строки видны по наведению — наводим, как человек.
  await page.locator(target).hover();
  await page.locator('button[aria-label="Редактировать: QaTool45"]').click();
  await page.getByRole('dialog').waitFor({ timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(
    (await searchBox.inputValue()) === 'QaTool4',
    'редактор, открытый со страницы, отбор человека не сбрасывает',
    await searchBox.inputValue(),
  );
}

console.log(`\nзаписи, не пропущенные к серверу: ${stub.blockedWrites.join(', ') || 'нет'}`);
await browser.close();
console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
