/**
 * Сценарии `check-mobile-device.mjs`. Каждый: `id` (фильтр `--only`),
 * `title`, необязательный `setup(ctx)` до сопряжения и `run(ctx)` на телефоне.
 * Телефон — на английском, пока сценарий сам не переключит язык.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, wait } from './throwaway-stand.mjs';
import { PACKAGE } from './android-device.mjs';
import { frame, json, readBody, upstreamJson } from './mobile-device-fixtures.mjs';
import { runDeskLive } from './mobile-device-desk.mjs';
import { makeRunReattach } from './mobile-device-reattach.mjs';

const require = createRequire(
  join(REPO, 'node_modules', '.pnpm', 'pngjs@5.0.0', 'node_modules', 'pngjs', 'package.json'),
);
const { PNG } = require('pngjs');

const CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Самый насыщенный цвет текста в прямоугольнике узла (фон тёмный и серый) —
 * ответ на «красным ли написано», которого дамп экрана не даёт.
 */
export function textColour(file, { x1, y1, x2, y2 }) {
  const png = PNG.sync.read(readFileSync(file));
  let best = { r: 0, g: 0, b: 0, s: -1 };
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const at = (png.width * y + x) * 4;
      const [r, g, b] = [png.data[at], png.data[at + 1], png.data[at + 2]];
      const s = Math.max(r, g, b) - Math.min(r, g, b);
      if (s > best.s) best = { r, g, b, s };
    }
  }
  return best;
}
export const isRed = (c) => c.r > c.g + 60 && c.r > c.b + 60;

/** Экран «Тесты» проекта: Проекты → недавний проект → чат → «Tests». */
async function openTests({ phone }) {
  phone.stopApp();
  phone.launch();
  await phone.tap(/^Projects$/, 30_000);
  await phone.tap(/\/proj$/);
  await phone.tap(/^Tests$/);
  return phone.waitFor(/^Autotests$/, 20_000);
}

async function appAlive(phone, pid) {
  const now = phone.pidOf();
  return Boolean(now) && (!pid || now === pid);
}

/** Язык приложения — переключателем в «Настройках», как человек. */
async function setLanguage(phone, language) {
  await phone.tap(language === 'ru' ? /^(Settings|Настройки)$/ : /^(Настройки|Settings)$/);
  await phone.tap(language === 'ru' ? 'Русский' : 'English');
  await wait(800);
}

/** Кейсы проекта: общий шаг из двух и кейс, который на него ссылается. */
async function setupTests({ stand, project, check }) {
  const post = (path, body) =>
    stand.api(path, { method: 'POST', body: { path: project, ...body } });
  await post('/project-tests/group', { id: 'gui', title: 'GUI' });
  const shared = await post('/project-tests/shared-step', {
    step: {
      title: 'Sign in',
      steps: [
        { action: 'Open login', expected: 'EXP-A1' },
        { action: 'Enter password', expected: 'EXP-A2' },
      ],
    },
  });
  const ref = shared.body?.sharedSteps?.[0]?.id;
  check('общий шаг заведён', Boolean(ref), shared.text.slice(0, 300));
  await post('/project-tests/case', {
    groupId: 'gui',
    testCase: {
      title: 'Manual ref case',
      steps: [
        { action: 'Sign in', ref },
        { action: 'Open settings', expected: 'EXP-B' },
        { action: 'Press save', expected: 'EXP-C' },
      ],
    },
  });
  const second = await post('/project-tests/case', {
    groupId: 'gui',
    testCase: { title: 'Second case', steps: ['Do the second thing'] },
  });
  const ids = second.body?.groups?.[0]?.cases?.map((item) => item.id) ?? [];
  check('два кейса в группе gui', ids.includes('gui-001') && ids.includes('gui-002'), ids.join());

  const started = await post('/project-tests/e2e/run', {});
  check('автотесты проекта запущены', started.status === 200, started.text.slice(0, 300));
  let run;
  for (let i = 0; i < 60; i += 1) {
    const view = await stand.api(`/project-tests?path=${encodeURIComponent(project)}`);
    run = view.body?.e2eRun;
    if (run && run.status !== 'running') break;
    await wait(500);
  }
  check(
    'прогон автотестов закончился красным (1 из 2 упал)',
    run?.summary?.failed === 1 && run?.summary?.total === 2,
    JSON.stringify(run)?.slice(0, 400),
  );
}

// ---------------------------------------------------------------- тесты

async function runF65(ctx) {
  const { phone, check, shot } = ctx;
  check('F-65 экран «Тесты» открылся', Boolean(await openTests(ctx)));
  const node = await phone.waitFor(/^1 of 2 failed, 1 passed\.$/, 10_000);
  const file = shot('f65-e2e-red-en');
  check('F-65 итог автотестов словами «1 of 2 failed, 1 passed.»', Boolean(node));
  const colour = node ? textColour(file, node.bounds) : undefined;
  check('F-65 итог красный', Boolean(colour && isRed(colour)), JSON.stringify(colour));
  const stale = await phone.find(/finished\.?$|^Done$|закончен/i);
  check(
    'F-65 нет «закончен/Done» над красным набором',
    stale.length === 0,
    stale.map((n) => n.text).join(),
  );
}

async function runF193(ctx) {
  const { phone, check, shot, proxy, stand } = ctx;
  let variant;
  const route = {
    name: 'e2e-error',
    match: (method, path) => method === 'GET' && path === '/api/project-tests',
    handle: async (req, res, url) => {
      const { status, body } = await upstreamJson(stand.apiUrl, req, url, (view) => ({
        ...view,
        e2eRun: { ...view.e2eRun, status: 'error', summary: undefined, ...variant },
      }));
      json(res, status, body);
    },
  };
  proxy.routes.unshift(route);
  try {
    variant = {
      errorCode: 'e2e-run-not-installed',
      errorParams: { dir: 'e2e', install: 'npm i -D @playwright/test' },
      error: 'Раннер не установлен.',
    };
    await openTests(ctx);
    const named = await phone.waitFor(/npm i -D @playwright\/test/, 10_000);
    shot('f359-not-installed-en');
    check('F-359 «раннер не установлен» называет команду установки', Boolean(named));
    check('F-359 и папку e2e', Boolean(named && /\be2e\b/.test(named.text)), named?.text);
    const red = named && textColour(shot('f359-not-installed-en'), named.bounds);
    check('F-359 текст ошибки красный', Boolean(red && isRed(red)), JSON.stringify(red));

    variant = { errorCode: 'e2e-run-code-from-the-future', error: 'SERVER-FALLBACK-TEXT' };
    await openTests(ctx);
    const fallback = await phone.waitFor(/^SERVER-FALLBACK-TEXT$/, 10_000);
    shot('f193-unknown-code-en');
    check('F-193 неизвестный код — текст сервера, а не пустота', Boolean(fallback));
  } finally {
    proxy.routes.splice(proxy.routes.indexOf(route), 1);
  }
}

async function runF360(ctx) {
  const { phone, check, shot } = ctx;
  await openTests(ctx);
  await phone.scrollTo(/^Run history$/);
  await phone.tap(/^Run history$/);
  const line = await phone.waitFor(/^The panel restarted while the run was going/, 15_000);
  shot('f360-run-history-en');
  check('F-360 ошибка записи истории — по коду, по-английски', Boolean(line), line?.text);
  const russian = (await phone.texts()).filter((text) => CYRILLIC.test(text));
  check('F-360 на английском экране нет кириллицы', russian.length === 0, russian.join(' ¦ '));
}

async function stepRows(phone) {
  return (await phone.screen()).filter((node) => node.clickable && /^\S, \d+\. /.test(node.desc));
}

async function runManual(ctx) {
  const { phone, check, shot, stand, project } = ctx;
  await openTests(ctx);
  await phone.scrollTo(/^Run by hand$/);
  await phone.tap(/^Run by hand$/);
  await phone.waitFor(/^Manual ref case$/, 15_000);
  let rows = await stepRows(phone);
  shot('f64-manual-steps-expanded-en');
  const texts = rows.map((row) => row.desc.replace(/^\S, /, ''));
  check('F-64 шаг-ссылка раскрыт: 4 шага вместо 3', rows.length === 4, texts.join(' ¦ '));
  check(
    'F-64 порядок раскрытых шагов',
    /^1\. Open login/.test(texts[0] ?? '') && /^3\. Open settings/.test(texts[2] ?? ''),
    texts.join(' ¦ '),
  );
  const russianStep = texts.filter((text) => CYRILLIC.test(text));
  check(
    'шаги ручного прогона на английском телефоне — без русских подписей («ожидание:»)',
    russianStep.length === 0,
    russianStep.join(' ¦ '),
  );

  // ✓ на первом шаге, ✕ на третьем (раскрытый номер 2, сырой — 1).
  await phone.tap(/^\S, 1\. Open login/);
  await phone.tap(/^\S, 3\. Open settings/);
  await phone.tap(/^\S, 3\. Open settings/);
  rows = await stepRows(phone);
  check(
    'отметки шагов до записи: ✓ 1, ✕ 3',
    rows[0]?.desc.startsWith('✓') && rows[2]?.desc.startsWith('✕'),
    rows.map((row) => row.desc.slice(0, 20)).join(' ¦ '),
  );
  shot('f64-marked-en');
  await phone.tap(/^Failed$/);
  await phone.waitFor(/^Second case$/, 10_000);

  const session = (await stand.api(`/project-tests/manual?path=${encodeURIComponent(project)}`))
    .body?.session;
  const result = session?.results?.find((item) => item.status === 'failed');
  const recorded = JSON.stringify(result ?? {});
  check(
    'F-64 сервер записал отметку шага по раскрытому номеру (index 2 = «Open settings»)',
    result?.steps?.some((step) => step.index === 2 && step.status === 'failed'),
    recorded,
  );
  check(
    'F-64 «ожидалось» провала — EXP-B, не чужое EXP-A2',
    recorded.includes('EXP-B') && !recorded.includes('EXP-A2'),
    recorded,
  );

  // F-366: назад к первому проходу — отметки восстанавливаются по номеру шага.
  await phone.tap(/^Back$/);
  await phone.waitFor(/^Manual ref case$/, 10_000);
  await wait(800);
  rows = await stepRows(phone);
  const marks = rows.map((row) => row.desc[0]).join('');
  shot('f366-restored-prev-en');
  check('F-366 «Назад»: отметки на своих шагах ✓·✕·', marks === '✓·✕·', marks);

  // Повторный заход на экран: тот же прогон с сервера.
  phone.back();
  await phone.waitFor(/^Autotests$/, 10_000);
  phone.shell(`am start -a android.intent.action.VIEW -d agentdeck://test-run ${PACKAGE}`);
  await phone.waitFor(/^Manual ref case$/, 15_000);
  await wait(800);
  const again = (await stepRows(phone)).map((row) => row.desc[0]).join('');
  shot('f366-restored-reentry-en');
  check('F-366 повторный заход: отметки на своих шагах ✓·✕·', again === '✓·✕·', again);

  await phone.tap(/^Drop the run$/);
  await wait(1500);
  const confirm = await phone.find(/^(Drop|OK|Yes|Drop the run)$/);
  if (confirm.length > 0) await phone.tap(confirm.at(-1).text || confirm.at(-1).desc);
}

// ---------------------------------------------------------------- агент панели

const pendingCard = (count) => ({
  id: `dlp-${count}`,
  name: 'dlp_rules_set',
  risk: 'write',
  preview: {
    summary: `Сохранить ${count} правил`,
    summaryCode: 'summary-dlp-rules',
    summaryParams: { count },
    fields: [],
  },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

async function openAgent(phone, view = /^(Conversation|Разговор)$/) {
  await phone.tap(/^(Agent|Агент)$/, 30_000);
  await phone.tap(view);
}

async function runF24(ctx) {
  const { phone, check, shot, proxy } = ctx;
  const route = {
    name: 'pending',
    match: (method, path) => method === 'GET' && path === '/api/agent/pending',
    handle: (req, res) => json(res, 200, [1, 3, 5, 21].map(pendingCard)),
  };
  proxy.routes.unshift(route);
  try {
    phone.stopApp();
    phone.launch();
    await wait(3000);
    const pid = phone.pidOf();
    await openAgent(phone);
    const en = {
      1: 'Save 1 data protection rule instead of the current list',
      3: 'Save 3 data protection rules instead of the current list',
      21: 'Save 21 data protection rules instead of the current list',
    };
    for (const [count, text] of Object.entries(en)) {
      const node = (await phone.scrollTo(text, 4)) ?? (await phone.waitFor(text, 5000));
      check(`F-24 en: карточка с числом ${count} нарисована словами`, Boolean(node), text);
    }
    shot('f24-pending-count-en');
    check('F-24 en: приложение живо (тот же процесс)', await appAlive(phone, pid));

    await setLanguage(phone, 'ru');
    await openAgent(phone, /^(Разговор|Conversation)$/);
    const ru = {
      1: 'Сохранить 1 правило защиты данных вместо нынешнего списка',
      3: 'Сохранить 3 правила защиты данных вместо нынешнего списка',
      5: 'Сохранить 5 правил защиты данных вместо нынешнего списка',
      21: 'Сохранить 21 правило защиты данных вместо нынешнего списка',
    };
    for (const [count, text] of Object.entries(ru)) {
      const node = (await phone.scrollTo(text, 4)) ?? (await phone.waitFor(text, 5000));
      check(
        `F-24 ru: форма числа ${count} — «${text.split(' ').slice(1, 3).join(' ')}»`,
        Boolean(node),
      );
    }
    shot('f24-pending-count-ru');
    check('F-24 ru: приложение живо (тот же процесс)', await appAlive(phone, pid));
    const crash = await phone.find(/Something went wrong|Что-то пошло не так|Try again|Повторить/);
    check('F-24 нет экрана сбоя', crash.length === 0, crash.map((n) => n.text).join());
    await setLanguage(phone, 'en');
  } finally {
    proxy.routes.splice(proxy.routes.indexOf(route), 1);
  }
}

async function runF369(ctx) {
  const { phone, check, shot, proxy } = ctx;
  const routes = [
    {
      name: 'conversations',
      match: (method, path) => method === 'GET' && path === '/api/agent/conversations',
      handle: (req, res) =>
        json(res, 200, [
          {
            id: 'c-broken',
            updatedAt: new Date().toISOString(),
            title: 'BROKEN-CONVERSATION',
            messages: 2,
          },
        ]),
    },
    {
      name: 'conversation-500',
      match: (method, path) => method === 'GET' && path === '/api/agent/conversations/c-broken',
      handle: (req, res) => json(res, 500, { message: 'disk read failed' }),
    },
  ];
  proxy.routes.unshift(...routes);
  try {
    phone.stopApp();
    phone.launch();
    await wait(3000);
    const pid = phone.pidOf();
    await openAgent(phone, /^History$/);
    await phone.tap(/^BROKEN-CONVERSATION$/, 15_000);
    const line = await phone.waitFor(/^The conversation did not open/, 10_000);
    shot('f369-open-failed-en');
    check('F-369 битый разговор — строка ошибки, а не пустота', Boolean(line), line?.text);
    check('F-369 приложение живо', await appAlive(phone, pid));
  } finally {
    for (const route of routes) proxy.routes.splice(proxy.routes.indexOf(route), 1);
  }
}

/** Написать агенту панели ASCII-текст и отправить. */
async function askAgent(phone, text) {
  await openAgent(phone);
  const [field] = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
  phone.tapAt(field.x, field.y);
  await wait(400);
  phone.type(text);
  phone.hideKeyboard();
  await wait(400);
  await phone.tap(/^Send$/);
}

/**
 * Ход агента панели из прокси. `script(res, entry)` пишет кадры; `entry.closedAt` —
 * когда телефон закрыл поток (обрыв со стороны клиента останавливает ход).
 */
function agentRunRoute(script) {
  return {
    name: 'agent-run',
    match: (method, path) => method === 'POST' && path === '/api/agent/run',
    handle: async (req, res, url, entry) => {
      entry.body = await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.on('close', () => {
        entry.closedAt = Date.now();
        entry.closedEarly = !entry.doneAt;
      });
      await script(res, entry);
    },
  };
}

const conversationRoute = (id, reply, delayMs, seen) => ({
  name: `conversation-${id}`,
  match: (method, path) => method === 'GET' && path === `/api/agent/conversations/${id}`,
  handle: async (req, res) => {
    seen.at ??= Date.now();
    await wait(delayMs);
    const at = new Date().toISOString();
    json(res, 200, {
      id,
      createdAt: at,
      updatedAt: at,
      context: { route: '/agent' },
      messages: [
        { role: 'user', content: 'first ask', at },
        { role: 'assistant', content: reply, at },
      ],
    });
  },
});

async function runF66(ctx) {
  const { phone, check, shot, proxy } = ctx;
  for (const tapNew of [false, true]) {
    const label = tapNew ? 'F-66' : 'F-66 контроль';
    const seen = {};
    const routes = [
      agentRunRoute(async (res) => {
        res.write(frame({ kind: 'start', conversationId: 'c-old', providerId: 'claude' }));
        res.write(frame({ kind: 'text', text: 'OLD-TURN-TEXT' }));
        // Дальше тишина: телефон сам решит, что связь пропала (30 с).
      }),
      conversationRoute('c-old', 'OLD-CONVERSATION-RELOADED', 8000, seen),
    ];
    proxy.routes.unshift(...routes);
    try {
      phone.stopApp();
      phone.launch();
      await wait(3000);
      await askAgent(phone, 'first ask');
      check(`${label}: ход начался`, Boolean(await phone.waitFor(/^OLD-TURN-TEXT$/, 15_000)));
      const until = Date.now() + 50_000;
      while (!seen.at && Date.now() < until) await wait(300);
      check(`${label}: после тишины телефон перечитывает разговор`, Boolean(seen.at));
      if (tapNew) await phone.tap(/^New conversation$/, 5000);
      await wait(12_000);
      const old = await phone.find(/^OLD-CONVERSATION-RELOADED$|^OLD-TURN-TEXT$/);
      shot(tapNew ? 'f66-new-conversation-kept-en' : 'f66-control-reload-shown-en');
      if (tapNew) {
        check(
          'F-66 новый разговор не затёрт перечитанным старым',
          old.length === 0,
          old.map((n) => n.text).join(),
        );
      } else {
        check(
          'F-66 контроль: без «Новый разговор» перечитанный разговор встаёт на экран',
          old.some((node) => node.text === 'OLD-CONVERSATION-RELOADED'),
        );
      }
    } finally {
      for (const route of routes) proxy.routes.splice(proxy.routes.indexOf(route), 1);
    }
  }
}

/**
 * F-101 на настоящем сервере: ход агента панели одноразовой панели (TurnFeed,
 * `detach`, возврат по номеру кадра) переживает 75 с фона. Прокси здесь только
 * пишет журнал — ход, его кадры и возврат отдаёт сам сервер. Android 15+ режет
 * сеть фоновому приложению, так что обрыв потока в фоне — не провал: провал —
 * ход, не доведённый до конца на экране, или «связь оборвалась».
 * Ход фальшивого CLI BGTURN кончается через 60 с (FAKE_BG_MS) — пока телефон в
 * фоне; сервер держит законченный ход ещё 60 с для возврата.
 */
/**
 * F-101, ревью MPU6 F8: поток закрывается и в обычном конце хода (через 60 с);
 * оборван в фоне — только если закрылся задолго до него. Возврат засчитан, если
 * сервер его обслужил, а не просто принял.
 */
export function streamCutInBackground({ closedAt, hiddenAt, attaches }) {
  return (
    Boolean(closedAt) &&
    closedAt - hiddenAt < 40_000 &&
    attaches.some((item) => /fromSeq=[1-9]/.test(item.query) && item.status === 200)
  );
}

async function runF101(ctx) {
  const { phone, check, shot, proxy } = ctx;
  const label = 'F-101 (настоящий сервер)';
  const from = proxy.log.length;
  const requests = () => proxy.log.slice(from);
  phone.stopApp();
  phone.launch();
  await wait(3000);
  await askAgent(phone, 'BGTURN long task');
  check(`${label}: ход начался`, Boolean(await phone.waitFor(/BG-TURN-STARTED/, 30_000)));
  const run = requests().find((item) => item.method === 'POST' && item.path === '/api/agent/run');
  check(`${label}: ход ушёл на сервер, а не в заглушку`, Boolean(run) && !run.stubbed);
  const hiddenAt = Date.now();
  phone.home();
  await wait(75_000);
  phone.resume();
  const finished = await phone.waitFor(/BG-TURN-FINISHED/, 45_000);
  await wait(1500);
  const cut = await phone.find(/^The connection dropped before the turn ended/);
  shot('f101-real-after-resume-en');
  const attaches = requests().filter(
    (item) => item.method === 'GET' && /^\/api\/agent\/run\/[^/]+\/stream$/.test(item.path),
  );
  const stops = requests().filter(
    (item) => item.method === 'POST' && /^\/api\/agent\/run\/[^/]+\/stop$/.test(item.path),
  );
  const dropped = run?.closedAt
    ? `поток закрыт через ${Math.round((run.closedAt - hiddenAt) / 1000)} с после ухода в фон`
    : 'поток не закрывался';
  ctx.notes.push(
    `${label}: ${dropped}; возвраты ${JSON.stringify(attaches.map((item) => item.query))}; стопов ${stops.length}`,
  );
  check(
    `${label}: ход дожил до конца после 75 с в фоне, без «связь оборвалась»`,
    Boolean(finished) && cut.length === 0,
    dropped,
  );
  check(
    `${label}: поток оборван в фоне и телефон вернулся к ходу по номеру кадра`,
    streamCutInBackground({ closedAt: run?.closedAt, hiddenAt, attaches }),
    `${dropped}; ${JSON.stringify(attaches.map((item) => `${item.query} ${item.status}`))}`,
  );
  check(`${label}: «Стоп» не посылался`, stops.length === 0);
}

// ---------------------------------------------------------------- чат и вопросы

async function runF67(ctx) {
  const { phone, check, shot, proxy, stand, project, sessionId } = ctx;
  // Гонка F-67: опрос `/chat/active` телефона ещё не увидел ход с компьютера.
  // Прокси прячет ход из этого списка — телефон узнаёт о нём только из 409.
  const hide = {
    name: 'hide-active',
    match: (method, path) => method === 'GET' && path === '/api/chat/active',
    handle: async (req, res, url) => {
      const { status, body } = await upstreamJson(stand.apiUrl, req, url, (list) =>
        Array.isArray(list) ? list.filter((run) => run.sessionId !== sessionId) : list,
      );
      json(res, status, body);
    },
  };
  proxy.routes.unshift(hide);
  try {
    phone.stopApp();
    phone.launch();
    await phone.tap(/^Home$/, 30_000);
    await phone.tap(/^Questions$/);
    check(
      'вопрос агента на телефоне',
      Boolean(await phone.waitFor(/^Which login stays the default\?$/, 20_000)),
    );
    // Ответ начат ДО хода с компьютера: он обязан пережить начало хода.
    await phone.tap(/^QR code$/);
    const before = await phone.find(/^Login: QR code$/);
    check('начатый ответ виден («Login: QR code»)', before.length === 1);

    // Ход с компьютера: держит разговор (FAKE_HOLD_MS в фальшивом CLI).
    const desk = fetch(`${stand.apiUrl}/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: `desk-${sessionId}`,
        sessionId,
        projectPath: project,
        prompt: 'HOLD the turn',
      }),
    }).then((res) => res.text());
    let running = false;
    for (let i = 0; i < 40 && !running; i += 1) {
      const active = (await stand.api('/chat/active')).body;
      running =
        Array.isArray(active) &&
        active.some((run) => run.sessionId === sessionId && run.status === 'running');
      if (!running) await wait(250);
    }
    check('ход с компьютера идёт', running);
    // Опрос сводки — раз в 5 с: ждём, пока телефон увидит идущий ход.
    await wait(8000);
    const kept = await phone.find(/^Login: QR code$/);
    shot('d2-answer-after-desk-turn-started-en');
    check(
      'начатый на телефоне ответ пережил начало хода с компьютера (ключ карточки не сменился)',
      kept.length === 1,
      (await phone.texts()).slice(0, 14).join(' ¦ '),
    );
    if (kept.length === 1) await phone.tap(/^Change$/);

    // F-154: «Другое», равное варианту, не удваивает ответ.
    await phone.tap(/^Other$/);
    const [field] = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
    phone.tapAt(field.x, field.y);
    await wait(300);
    phone.type('QR code');
    phone.hideKeyboard();
    await wait(300);
    await phone.tap(/^Done$/);
    await phone.waitFor(/^What to check after the change\?$/, 10_000);
    await phone.tap(/^Unit$/);
    await phone.tap(/^E2E$/);
    await phone.tap(/^Next$/);
    await phone.waitFor(/^Send$/, 10_000);
    const summary = await phone.find(/^Login: /);
    check(
      'F-154 свёрнутый ответ без повтора «QR code, QR code»',
      summary[0]?.text === 'Login: QR code',
      summary[0]?.text,
    );
    shot('f154-f67-ready-to-send-en');
    // Пока ответ ждёт конца хода и пока CLI его записывает, карточка не должна
    // возвращаться ни на одном кадре (F-190), а вкладка — считать её (F-153).
    const samples = [];
    let sentAt = 0;
    let cardBackShot;
    const sample = async () => {
      const texts = await phone.texts();
      samples.push({
        at: Date.now(),
        card: texts.some(
          (text) => text === 'Which login stays the default?' || text === 'Set up the phone login',
        ),
        tab: texts.find((text) => text.startsWith('Questions: ')) ?? '',
      });
      const last = samples.at(-1);
      if (sentAt && last.card && !cardBackShot) cardBackShot = shot('f190-card-back-en');
    };
    // Контроль детектора: карточка на экране — кадр обязан её увидеть, иначе
    // «не вернулась ни на одном кадре» ниже ничего не доказывает.
    await sample();
    const control = samples.pop();
    check(
      'контроль: детектор кадров видит неотправленную карточку и её счёт',
      control.card && /^Questions: [1-9]/.test(control.tab),
      JSON.stringify(control),
    );
    sentAt = Date.now();
    await phone.tap(/^Send$/);
    await wait(3000);
    const failed = await phone.find(/^Not sent/);
    shot('f67-after-send-en');
    const sends = () =>
      proxy.log.filter(
        (entry) => entry.method === 'POST' && entry.path === '/api/chat/send' && entry.at >= sentAt,
      );
    check(
      'F-67 первый POST /chat/send телефона получил 409 (гонка воспроизведена)',
      sends()[0]?.status === 409,
      JSON.stringify(sends()),
    );
    check(
      'F-67 карточка не пишет «Not sent»',
      failed.length === 0,
      failed.map((n) => n.text).join(),
    );

    const until = Date.now() + 90_000;
    let delivered = [];
    let deliveredAt;
    // Жива ли сама панель: зависшая панель не закрыла бы поток хода.
    const health = [];
    const probe = setInterval(() => {
      const at = Date.now();
      const tag = (what) => health.push(`${Math.round((at - sentAt) / 1000)}s:${what}`);
      stand
        .api('/chat/active')
        .then((res) =>
          tag(
            `${res.status}/${Date.now() - at}ms/${
              Array.isArray(res.body)
                ? res.body.map((run) => `${run.chatId.slice(0, 8)}=${run.status}`).join(',')
                : ''
            }`,
          ),
        )
        .catch((error) => tag(`ERR ${error.cause?.code ?? error.message}`));
    }, 10_000);
    while (Date.now() < until) {
      await sample();
      delivered = ctx.calls().filter((call) => call.text?.includes('QR code'));
      if (delivered.length > 0) deliveredAt ??= Date.now();
      if (deliveredAt && Date.now() - deliveredAt > 20_000) break;
      // adb вызывается синхронно: без настоящей паузы прокси и панель в этом же
      // процессе не получают ни такта, и телефон ждёт ответов впустую.
      await wait(400);
    }
    clearInterval(probe);
    console.log(`    панель во время ожидания: ${health.join(' | ')}`);
    await desk.catch(() => undefined);
    check(
      'F-67 ответ дошёл до агента после конца хода',
      delivered.length === 1,
      `${JSON.stringify(delivered)}\n    вызовы CLI: ${JSON.stringify(ctx.calls())}\n    запросы телефона после отправки: ${proxy.log
        .filter((entry) => entry.at >= sentAt)
        .map(
          (entry) =>
            `${Math.round((entry.at - sentAt) / 1000)}s ${entry.method} ${entry.path} ${entry.status}${entry.closedAt ? ` closed ${Math.round((entry.closedAt - sentAt) / 1000)}s` : ''}`,
        )
        .join(' | ')}`,
    );
    const text = delivered[0]?.text ?? '';
    check('F-154 в сообщении агенту «QR code» один раз', text.split('QR code').length === 2, text);
    check('ответ несёт и второй вопрос (Unit, E2E)', /Unit/.test(text) && /E2E/.test(text), text);
    const deskFirst = ctx.calls().findIndex((call) => call.text?.includes('HOLD'));
    const answerAt = ctx.calls().findIndex((call) => call.text?.includes('QR code'));
    check(
      'ответ ушёл ПОСЛЕ хода с компьютера, а не вместо него',
      deskFirst >= 0 && answerAt > deskFirst,
    );

    // F-153/F-190: все кадры с отправки до 20 с после доставки.
    const inbox = (await stand.api('/chat/inbox')).body;
    const serverDropped = !JSON.stringify(inbox ?? {}).includes('Which login stays the default?');
    shot('f153-f190-after-delivery-en');
    const back = samples.filter((item) => item.card);
    const counted = samples.filter((item) => item.tab !== 'Questions: nothing waiting');
    const when = (list) =>
      list.map((item) => `${Math.round((item.at - sentAt) / 1000)}s:${item.tab}`).join(', ');
    console.log(
      `    кадров снято: ${samples.length} за ${Math.round((Date.now() - sentAt) / 1000)} с`,
    );
    check('сервер снял вопрос, когда CLI записал ответ', serverDropped);
    check(
      'F-190 отвеченная карточка не вернулась ни на одном кадре',
      back.length === 0,
      when(back),
    );
    check(
      'F-153 вкладка «Вопросы» не считала отвеченное ни на одном кадре',
      counted.length === 0,
      when(counted),
    );
  } finally {
    proxy.routes.splice(proxy.routes.indexOf(hide), 1);
  }
}

// ---------------------------------------------------------------- обход экранов на русском

async function runWalkRu(ctx) {
  const { phone, check, shot } = ctx;
  phone.stopApp();
  phone.launch();
  await setLanguage(phone, 'ru');
  await phone.tap(/^Главная$/);
  shot('walk-ru-home');
  await phone.tap(/^Вопросы$/);
  shot('walk-ru-questions');
  await phone.tap(/^Проекты$/);
  await phone.tap(/\/proj$/);
  await phone.tap(/^Тесты$/);
  const red = await phone.waitFor(/^Упало 1 из 2, прошло 1.$/, 15_000);
  shot('walk-ru-tests');
  check('обход ru: итог автотестов по-русски', Boolean(red), red?.text);
  await phone.scrollTo(/^История прогонов$/);
  await phone.tap(/^История прогонов$/);
  const orphan = await phone.waitFor(/^Панель перезапустилась/, 15_000);
  shot('walk-ru-test-runs');
  check('обход ru: запись истории по коду по-русски', Boolean(orphan), orphan?.text);
  phone.stopApp();
  phone.launch();
  await setLanguage(phone, 'en');
  check('обход ru: приложение живо', Boolean(phone.pidOf()));
}

// ---------------------------------------------------------------- отключение от панели

/**
 * Ревью MPU6, F5: `queryClient.clear()` не доходил до смонтированных экранов —
 * после «Disconnect» «Настройки» держали устройства и уведомления прежней
 * панели. Узел-функция (`panel-cache.test.ts`) это закрепляет; здесь — в APK.
 * В конце телефон сопрягается заново: сценарии после этого идут как обычно.
 */
async function runDisconnect(ctx) {
  const { phone, stand, check, shot } = ctx;
  const LABEL = 'old-panel-phone';
  const added = await stand.api('/remote/devices', {
    method: 'POST',
    body: { token: 'ExponentPushToken[disconnect-check]', platform: 'android', label: LABEL },
  });
  check('устройство заведено на одноразовой панели', added.status === 200, added.text);

  phone.stopApp();
  phone.launch();
  await phone.tap(/^Settings$/, 30_000);
  const device = await phone.scrollTo(new RegExp(`^${LABEL}$`));
  check('до отключения «Настройки» показывают устройство панели', Boolean(device));
  shot('f5-settings-before-disconnect-en');

  for (let swipe = 0; swipe < 6; swipe += 1) phone.shell('input swipe 540 700 540 1800 300');
  await phone.tap(/^Disconnect$/);
  const notPaired = await phone.waitFor(/^Not connected$/, 10_000);
  // Прежний статус пропадает весь: список устройств, тумблер и пробное уведомление.
  const stale = new RegExp(
    `^(${LABEL}|Devices|Test notification|. The panel sends notifications)$`,
  );
  const gone = await phone.waitGone(stale, 10_000);
  shot('f5-settings-after-disconnect-en');
  check('после отключения — «Not connected»', Boolean(notPaired));
  check(
    'F5 после отключения в «Настройках» нет ничего от прежней панели',
    gone,
    (await phone.find(stale)).map((node) => node.text || node.desc).join(' ¦ '),
  );
  check('телефон сопряжён заново для следующих сценариев', await ctx.pair());
}

export const SCENARIOS = [
  { id: 'f65', title: 'итог красных автотестов (F-65)', setup: setupTests, run: runF65 },
  { id: 'f193', title: 'ошибки запуска автотестов по коду (F-193, F-359)', run: runF193 },
  { id: 'f360', title: 'история прогонов на языке телефона (F-360)', run: runF360 },
  { id: 'manual', title: 'ручной прогон: раскрытые шаги и отметки (F-64, F-366)', run: runManual },
  { id: 'f24', title: 'карточка агента с числом в Hermes (F-24)', run: runF24 },
  { id: 'f369', title: 'битый разговор агента (F-369)', run: runF369 },
  { id: 'f66', title: 'перечитка не затирает новый разговор (F-66)', run: runF66 },
  { id: 'f67', title: 'ответ в первые секунды хода (F-67, F-153, F-154, F-190)', run: runF67 },
  { id: 'walk-ru', title: 'обход тронутых экранов на русском', run: runWalkRu },
  { id: 'f101', title: 'ход агента на настоящем сервере переживает фон (F-101)', run: runF101 },
  { id: 'b1', title: 'ход со стола: вопрос, статус, субагенты (1b)', run: runDeskLive },
  {
    id: 'd3',
    title: 'ход агента переживает фон: возврат по номеру кадра (F-101 D3)',
    run: makeRunReattach({ askAgent }),
  },
  {
    id: 'f5',
    title: 'отключение снимает статус прежней панели (ревью MPU6 F5)',
    run: runDisconnect,
  },
];
