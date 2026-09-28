/**
 * Окно агента панели: механика, которую `check-panel-agent.mjs` не трогает, — то,
 * что случается с окном, а не с карточкой. API агента подменён целиком (как там):
 * прогон не зависит от установленного CLI и ничего не выполняет в панели.
 *
 * - Ответ разметкой читается без дыр: список и абзацы не наследуют `pre-wrap`
 *   пузыря сообщения (переводы строк разметки рисовались пустыми строками).
 * - Кнопки карточки в первые полсекунды не молчат: нажатие показывает почему.
 * - Чужая карточка (другой разговор) окно не открывает — только значок.
 * - Устаревшая вкладка: отказ `conversation_stale` перечитывает разговор и
 *   называет неотправленный текст, а не затирает чужой ход.
 * - F5 посреди хода: окно возвращается с тем же разговором и говорит, что ход
 *   оборвала перезагрузка; «Новый разговор» память стирает.
 * - Поток хода замолчал (сервер перезапустился за прокси): окно не висит в
 *   «Агент думает…», а заканчивает ход и перечитывает разговор с сервера.
 * - Микрофон, который не отвечает (нет устройства, распознаватель молчит): окно
 *   говорит об этом, а «Отправить» не ждёт вечно.
 *
 * Запуск: `node tools/qa/check-panel-agent-window.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `--shots <dir> [TAG]` — кадры.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
const TAG = shotsAt > 0 && process.argv[shotsAt + 2] ? process.argv[shotsAt + 2] : 'run';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const onlyList = onlyAt > 0 ? process.argv[onlyAt + 1] : process.env.ONLY;
const only = onlyList ? new Set(onlyList.split(',')) : undefined;
const wants = (name) => !only || only.has(name);

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ок  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}_${TAG}.png`) });
};

const at = '2026-09-26T10:00:00.000Z';
const MARKDOWN_REPLY =
  'Нашёл два правила:\n\n- **первое** — про стиль\n- **второе** — про тесты\n\nГотово.';

/** Что «сервер» знает и что пришло от окна. */
const stub = {
  pending: [],
  decisions: [],
  runBodies: [],
  runMode: 'markdown',
  conversations: {},
  conversationReads: [],
};

const card = (id, conversationId) => ({
  id,
  name: 'create_project',
  risk: 'change',
  conversationId,
  preview: { summary: `QA-карточка ${id}`, fields: [{ label: 'Каталог', value: 'C:/work/qa' }] },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});

/** Поток `/api/events` и распознаватель речи — подмены страницы, как в check-panel-agent. */
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
  // Ход, чей поток открылся и замолчал: кадр start, кусок текста и тишина. Так
  // выглядит перезапуск сервера за прокси Vite — соединение не рвётся, кадров нет.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const hang = window.__qaRunHang;
    if (hang && url.endsWith('/api/agent/run')) {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const frame = (event) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          frame({ kind: 'start', conversationId: hang, providerId: 'claude' });
          frame({ kind: 'text', text: 'Сказано до обрыва.' });
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
          // Уход страницы рвёт настоящий запрос ещё при живом JS — и окно видит
          // «конец хода» перед самой перезагрузкой (живой прогон 26.09 это поймал).
          window.addEventListener('pagehide', () => {
            try {
              controller.error(new TypeError('network error'));
            } catch {
              // поток уже закрыт
            }
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    return realFetch(input, init);
  };
  window.__qaSpeech = { mode: 'silent', starts: 0 };
  class QaRecognition {
    start() {
      window.__qaSpeech.starts += 1;
      if (window.__qaSpeech.mode === 'audio-capture') {
        setTimeout(() => {
          this.onerror?.({ error: 'audio-capture' });
          this.onend?.();
        }, 0);
      }
      // 'silent': распознаватель без микрофона в безголовом Chromium — ни одного события.
    }
    stop() {}
  }
  window.SpeechRecognition = QaRecognition;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(pageStubs);
// Сокет горячей перезагрузки Vite отвечаем на месте: правка любого файла на стенде
// иначе перезагружала страницу посреди сценария и роняла его (голос — 2 из 4).
const appPort = new URL(BASE).port;
await context.routeWebSocket(
  (url) => url.port === appPort && url.pathname === '/',
  () => undefined,
);
const page = await context.newPage();
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
await bypassOnboarding(page);

await page.route('**/api/agent/pending', (route) =>
  route.fulfill({ json: stub.pending }).catch(() => undefined),
);
await page.route('**/api/agent/pending/*', async (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
  const body = route.request().postDataJSON();
  stub.decisions.push({ id, ...body });
  await route.fulfill({ json: { ok: true } }).catch(() => undefined);
  stub.pending = stub.pending.filter((item) => item.id !== id);
  await page
    .evaluate((frame) => window.__qaEmit(frame), {
      type: 'agent-decided',
      id,
      outcome: body.decision === 'approve' ? 'done' : 'rejected',
    })
    .catch(() => undefined);
});
await page.route('**/api/agent/run', async (route) => {
  const body = route.request().postDataJSON();
  stub.runBodies.push(body);
  if (stub.runMode === 'stale') {
    return route
      .fulfill({
        status: 409,
        json: {
          error: 'conversation_stale',
          message: 'Разговор продолжили в другой вкладке — QA-отказ.',
        },
      })
      .catch(() => undefined);
  }
  const frames = [
    { kind: 'start', conversationId: 'qa-w-conv', providerId: 'claude' },
    { kind: 'text', text: MARKDOWN_REPLY },
    { kind: 'done', reply: MARKDOWN_REPLY },
  ];
  await route
    .fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    })
    .catch(() => undefined);
});
await page.route('**/api/agent/journal*', (route) =>
  route.fulfill({ json: [] }).catch(() => undefined),
);
await page.route('**/api/agent/conversations', (route) =>
  route.fulfill({ json: [] }).catch(() => undefined),
);
await page.route('**/api/agent/conversations/*', (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
  stub.conversationReads.push(id);
  const conversation = stub.conversations[id];
  return (
    conversation
      ? route.fulfill({ json: conversation })
      : route.fulfill({
          status: 404,
          json: { error: 'not_found', message: 'Такого разговора нет.' },
        })
  ).catch(() => undefined);
});

const trigger = page.locator('[data-panel-agent-trigger]');
const win = page.locator('[data-panel-agent-window]');
const input = win.locator('[data-agent-input]');
const emit = (frame) => page.evaluate((f) => window.__qaEmit(f), frame);
const feedText = async () =>
  (await win.locator('[data-agent-feed]').innerText()).replace(/\s+/g, ' ');
const notices = () => win.locator('[data-agent-notice]').allInnerTexts();
const send = async (text) => {
  await input.fill(text);
  await input.press('Enter');
};
const waitIdle = (timeout = 10_000) =>
  page
    .waitForFunction(
      () =>
        !document.querySelector('[data-panel-agent-window]')?.textContent?.includes('Агент думает'),
      null,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
const newConversation = async () => {
  const button = win.getByRole('button', { name: 'Новый разговор' });
  if (await button.count()) await button.click();
};

await page.goto(`${BASE}/`);
await trigger.waitFor({ timeout: 30_000 });
await trigger.click();
await input.waitFor();

// ── Ответ разметкой ──────────────────────────────────────────────────────────
if (wants('markdown')) {
  await send('QA: сколько правил?');
  await win.locator('[data-agent-message="assistant"] ul').first().waitFor({ timeout: 10_000 });
  const layout = await win
    .locator('[data-agent-message="assistant"]')
    .first()
    .evaluate((bubble) => {
      const list = bubble.querySelector('ul');
      const item = bubble.querySelector('li');
      return {
        whiteSpace: getComputedStyle(list).whiteSpace,
        // Высота строки списка против высоты текста в ней: `pre-wrap` дописывал
        // перевод строки после каждого <li> пустой строкой.
        bubble: bubble.getBoundingClientRect().height,
        line: item.getBoundingClientRect().height,
      };
    });
  check(
    layout.whiteSpace === 'normal',
    `разметка ответа не наследует pre-wrap пузыря (white-space: ${layout.whiteSpace})`,
  );
  // Абзац + два пункта + абзац ≈ четыре строки текста; пустые строки между
  // ними раздували пузырь вдвое.
  check(
    layout.bubble < layout.line * 7,
    `пузырь ответа без пустых строк (${Math.round(layout.bubble)}px при строке ${Math.round(layout.line)}px)`,
  );
  await shot(page, 'markdown');
}

// ── Кнопки карточки в первые полсекунды ─────────────────────────────────────
if (wants('arm')) {
  if (!(await page.evaluate(() => true))) throw new Error('page gone');
  const ownId = wants('markdown') ? 'qa-w-conv' : undefined;
  stub.pending = [card('qa-arm', ownId)];
  const early = await page.evaluate(async (pending) => {
    window.__qaEmit({ type: 'agent-pending', pending });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reject = document.querySelector(
      '[data-agent-pending="qa-arm"] [data-agent-decision="reject"]',
    );
    const disabled = reject?.getAttribute('aria-disabled');
    reject?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hint = document.querySelector('[data-agent-pending="qa-arm"] [data-agent-arm-hint]');
    return { found: Boolean(reject), disabled, hint: hint?.textContent ?? '' };
  }, stub.pending[0]);
  check(early.found, 'карточка на месте через 80 мс');
  check(
    early.disabled === 'true',
    `кнопки в первые полсекунды помечены недоступными (aria-disabled=${early.disabled})`,
  );
  check(early.hint.length > 0, `ранний клик объяснён строкой на карточке («${early.hint}»)`);
  await shot(page, 'arm-early');
  await page.waitForTimeout(150);
  check(stub.decisions.length === 0, 'ранний клик ничего не решил');
  await page.waitForTimeout(600);
  const armed = await win
    .locator('[data-agent-pending="qa-arm"] [data-agent-decision="reject"]')
    .getAttribute('aria-disabled');
  check(armed !== 'true', 'через полсекунды кнопки доступны');
  check(
    (await win.locator('[data-agent-pending="qa-arm"] [data-agent-arm-hint]').count()) === 0,
    'строка о задержке ушла вместе с задержкой',
  );
  await win.locator('[data-agent-pending="qa-arm"] [data-agent-decision="reject"]').click();
  await page.waitForTimeout(400);
  check(
    stub.decisions.some((item) => item.id === 'qa-arm' && item.decision === 'reject'),
    'после задержки «Отклонить» отправляет решение',
  );
}

// ── Чужая карточка окно не открывает ───────────────────────────────────────
if (wants('foreign')) {
  await win.getByRole('button', { name: 'Закрыть' }).first().click();
  await page.waitForTimeout(500);
  check(!(await win.isVisible()), 'окно закрыто перед чужой карточкой');
  stub.pending = [card('qa-foreign', 'qa-other-conversation')];
  await emit({ type: 'agent-pending', pending: stub.pending[0] });
  await page.waitForTimeout(800);
  check(!(await win.isVisible()), 'карточка другого разговора окно не открыла');
  check(
    ((await trigger.getAttribute('aria-label')) ?? '').includes('Ждут решения: 1'),
    'о чужой карточке говорит значок на кнопке',
  );
  await shot(page, 'foreign-card');
  // Своя карточка по-прежнему открывает окно.
  if (wants('markdown')) {
    const own = card('qa-own', 'qa-w-conv');
    stub.pending = [...stub.pending, own];
    await emit({ type: 'agent-pending', pending: own });
    await page.waitForTimeout(800);
    check(await win.isVisible(), 'карточка своего разговора окно открывает');
  }
  stub.pending = [];
  await emit({ type: 'agent-decided', id: 'qa-foreign', outcome: 'rejected' });
  await emit({ type: 'agent-decided', id: 'qa-own', outcome: 'rejected' });
  if (!(await win.isVisible())) await trigger.click();
}

// ── Вкладка устарела ──────────────────────────────────────────────────────
if (wants('stale') && wants('markdown')) {
  stub.conversations['qa-w-conv'] = {
    id: 'qa-w-conv',
    createdAt: at,
    updatedAt: at,
    context: { route: '/' },
    messages: [
      { role: 'user', content: 'QA: сколько правил?', at },
      { role: 'assistant', content: MARKDOWN_REPLY, at },
      { role: 'user', content: 'QA: ответ из другой вкладки?', at },
      { role: 'assistant', content: 'QA-бета из другой вкладки', at },
    ],
  };
  stub.runMode = 'stale';
  stub.conversationReads = [];
  await send('QA: гамма из устаревшей вкладки');
  await page.waitForTimeout(1500);
  const feed = await feedText();
  check(
    stub.conversationReads.includes('qa-w-conv'),
    'отказ conversation_stale перечитал разговор',
  );
  check(feed.includes('QA-бета из другой вкладки'), 'в ленте ход, сделанный в другой вкладке');
  const said = (await notices()).join(' | ');
  check(
    said.includes('QA: гамма из устаревшей вкладки'),
    `заметка называет неотправленный текст («${said.slice(0, 200)}»)`,
  );
  await shot(page, 'stale-tab');
  stub.runMode = 'markdown';
}

// ── F5 посреди хода ─────────────────────────────────────────────────────────
if (wants('reload')) {
  await newConversation();
  stub.conversations['qa-w-reload'] = {
    id: 'qa-w-reload',
    createdAt: at,
    updatedAt: at,
    context: { route: '/' },
    messages: [
      { role: 'user', content: 'QA: перезагрузка посреди хода', at },
      {
        role: 'assistant',
        content: 'Сказано до обрыва.\n\nОтвет не дописан. Окно закрыто.',
        at,
        interrupted: true,
      },
    ],
  };
  await page.evaluate(() => {
    window.__qaRunHang = 'qa-w-reload';
  });
  await send('QA: перезагрузка посреди хода');
  await win.getByText('Агент думает').waitFor({ timeout: 5000 });
  // Карточка оборванного хода: сервер снимает её с опозданием, уже после того,
  // как новая страница прочла список, и кадр итога до страницы не доходит.
  stub.pending = [card('qa-reload-card', 'qa-w-reload')];
  setTimeout(() => {
    stub.pending = stub.pending.filter((item) => item.id !== 'qa-reload-card');
  }, 1500);
  await page.reload();
  await trigger.waitFor({ timeout: 30_000 });
  const opened = await win
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(opened, 'после F5 посреди хода окно открылось само');
  if (opened) {
    await page.waitForTimeout(800);
    const feed = await feedText();
    check(feed.includes('QA: перезагрузка посреди хода'), 'разговор вернулся после F5');
    check(feed.includes('Сказано до обрыва'), 'сказанное до обрыва видно (запечатанный ход)');
    const said = (await notices()).join(' | ');
    check(/перезагруз/i.test(said), `заметка говорит, что ход оборвала перезагрузка («${said}»)`);
    await page.waitForTimeout(4000);
    check(
      (await win.locator('[data-agent-pending="qa-reload-card"]').count()) === 0,
      'карточка оборванного хода, снятая сервером с опозданием, из окна ушла',
    );
    await shot(page, 'after-reload');
    await newConversation();
    await page.reload();
    await trigger.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    check(!(await win.isVisible()), 'после «Новый разговор» и F5 окно не открывается само');
    await trigger.click();
    await input.waitFor();
    check(
      !(await feedText()).includes('перезагрузка посреди хода'),
      '«Новый разговор» стёр память окна',
    );
  } else {
    await trigger.click();
    await input.waitFor();
    await shot(page, 'after-reload');
  }
}

// ── Поток замолчал ─────────────────────────────────────────────────────────
if (wants('hang')) {
  await newConversation();
  stub.conversations['qa-w-hang'] = {
    id: 'qa-w-hang',
    createdAt: at,
    updatedAt: at,
    context: { route: '/' },
    messages: [
      { role: 'user', content: 'QA: поток замолчит', at },
      {
        role: 'assistant',
        content: 'Сказано до обрыва.\n\nОтвет не дописан. Панель перезапустилась.',
        at,
        interrupted: true,
      },
    ],
  };
  await page.evaluate(() => {
    window.__qaRunHang = 'qa-w-hang';
  });
  stub.conversationReads = [];
  const started = Date.now();
  await send('QA: поток замолчит');
  const ended = await waitIdle(60_000);
  const took = Math.round((Date.now() - started) / 1000);
  check(ended, `замолчавший поток не держит «Агент думает…» вечно (${took} с)`);
  if (ended) {
    const said = (await notices()).join(' | ');
    check(/связ|поток/i.test(said), `заметка называет обрыв связи («${said}»)`);
    await page.waitForTimeout(800);
    check(
      stub.conversationReads.includes('qa-w-hang'),
      'после обрыва разговор перечитан с сервера',
    );
    check(
      (await feedText()).includes('Панель перезапустилась'),
      'запечатанный ход с сервера в ленте',
    );
  }
  await shot(page, 'stream-lost');
  await page.evaluate(() => {
    window.__qaRunHang = undefined;
  });
}

// ── Остановили ход, в котором агент уже говорил ────────────────────────────
// Сервер запечатывает такой ход в файле; окно сбрасывало пару и до конца сессии
// показывало ленту короче той, что видит модель (ревью Z5-2).
if (wants('stop')) {
  await newConversation();
  stub.conversations['qa-w-stop'] = {
    id: 'qa-w-stop',
    createdAt: at,
    updatedAt: at,
    context: { route: '/' },
    messages: [
      { role: 'user', content: 'QA: остановлю', at },
      // Так ход пишет сервер (F-50): хвост английский — его читает модель, —
      // а пометку человеку окно собирает своим языком по коду `seal`.
      {
        role: 'assistant',
        content:
          'Сказано до обрыва.\n\nActions performed: navigate, open_rule (failed).\n\nThe answer was not finished: the turn was stopped.',
        at,
        interrupted: true,
        seal: { reason: 'stopped', actions: ['navigate', 'open_rule (failed)'] },
      },
    ],
  };
  await page.evaluate(() => {
    window.__qaRunHang = 'qa-w-stop';
  });
  stub.conversationReads = [];
  await send('QA: остановлю');
  await win.getByText('Сказано до обрыва.').first().waitFor({ timeout: 5000 });
  await win.getByRole('button', { name: 'Остановить', exact: true }).click();
  check(await waitIdle(5000), 'Stop заканчивает ход');
  await page.waitForTimeout(1500);
  check(stub.conversationReads.includes('qa-w-stop'), 'после Stop разговор перечитан с сервера');
  const sealedFeed = await feedText();
  check(
    sealedFeed.includes('Ответ не дописан. Ход остановлен.') &&
      sealedFeed.includes('Выполненные действия: navigate, open_rule (ошибка).'),
    'запечатанный сервером ход в ленте после Stop — пометка на языке окна',
  );
  check(
    !sealedFeed.includes('The answer was not finished') && !sealedFeed.includes('(failed)'),
    'английский хвост для модели человеку не показан',
  );
  check(
    (await notices()).some((text) => text.includes('Ход остановлен')),
    'строка «Ход остановлен» осталась в ленте',
  );
  await shot(page, 'stopped-sealed');
  await page.evaluate(() => {
    window.__qaRunHang = undefined;
  });
}

// ── Микрофон не отвечает ────────────────────────────────────────────────────
if (wants('voice')) {
  await newConversation();
  const mic = win.locator('[data-agent-voice]');
  const caption = win.locator('[data-agent-voice-caption]');
  await page.evaluate(() => {
    window.__qaSpeech.mode = 'audio-capture';
  });
  await mic.click();
  await page.waitForTimeout(500);
  check(
    (await caption.getAttribute('data-agent-voice-caption')) === 'microphone',
    `нет микрофона (audio-capture) названо своими словами (${await caption.getAttribute('data-agent-voice-caption')}: «${await caption.innerText()}»)`,
  );
  await shot(page, 'voice-audio-capture');
  // Доступ дан, а распознаватель молчит — сторож старта (15 с). Без доступа
  // безголовый Chromium держит 'prompt', и сторож ждёт ответа человека до
  // PROMPT_GRACE_MS (F-335) — этот предел закреплён в web-speech-provider.test.ts.
  await context.grantPermissions(['microphone'], { origin: new URL(BASE).origin });
  await page.evaluate(() => {
    window.__qaSpeech.mode = 'silent';
  });
  await mic.click();
  await page.waitForTimeout(16_000);
  const view = await caption.getAttribute('data-agent-voice-caption');
  check(view === 'microphone', `молчащий распознаватель не держит «Говорите…» вечно (${view})`);
  await input.fill('QA: текст руками');
  check(
    await win.getByRole('button', { name: 'Отправить' }).isEnabled(),
    '«Отправить» доступна после молчащего микрофона',
  );
  await shot(page, 'voice-silent');
  // Стоп без ответа распознавателя тоже не держит «Перевожу речь…».
  await mic.click();
  await page.waitForTimeout(500);
  if ((await mic.getAttribute('data-agent-voice')) === 'listening') await mic.click();
  await page.waitForTimeout(4000);
  const after = await mic.getAttribute('data-agent-voice');
  check(
    after !== 'finalizing' && after !== 'listening',
    `стоп без ответа распознавателя отпускает микрофон (${after})`,
  );
}

await browser.close();
if (failures.length > 0) {
  console.log(`\nОкно агента (механика): ${failures.length} провал(ов).`);
  process.exit(1);
}
console.log('\nОкно агента (механика): чисто.');
