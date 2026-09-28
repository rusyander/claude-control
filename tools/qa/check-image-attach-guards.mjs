/**
 * Охрана картинок в полях агента от быстрых рук (ревью 28.09: F-92, F-93, F-94).
 *
 * - send  — чат чужого CLI: два Enter подряд, пока картинка кладётся к панели,
 *   отправляют сообщение ОДИН раз и кладут картинку один раз; набранное за время
 *   отправки остаётся в поле, а ушедшее — нет.
 * - count — агент панели: две вставки по пять картинок подряд, не дожидаясь
 *   ужатия, дают восемь чипов, а не десять, и две лишние названы в отказе.
 * - drop  — агент панели занят ответом: файл, брошенный на поле, перехвачен
 *   (браузер не уводит страницу), черновик цел, отказ сказан словами.
 * - size  — картинка на байт больше предела: в отказе «20,1 МБ», а не сам
 *   предел (F-334).
 * - unmount — окно агента закрыто посреди ужатия: object URL, созданные после
 *   ухода поля, тоже отозваны (F-341).
 *
 * API агента, чата чужого CLI и склада картинок подменены; любая иная запись
 * (не GET) до сервера не доходит, настройки подменяются только в ответе этой
 * вкладке — конфигурация человека не трогается, CLI не запускается.
 *
 * Запуск: `node tools/qa/check-image-attach-guards.mjs` при поднятом `pnpm dev`
 * (`APP_URL`, по умолчанию http://localhost:8888). `--only send,count,drop,size,unmount`.
 * `SHOTS=<каталог>` — кадр отказа по размеру.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

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

/** Настоящий PNG 1×1: панель его читает и ужимает, как любой снимок. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const at = '2026-09-28T10:00:00.000Z';

/** Поток `/api/events` подменён: кадров сценарию не нужно, а стенд не мешает. */
const pageStubs = () => {
  class QaEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      setTimeout(() => this.onopen?.(new Event('open')), 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = QaEventSource;
};

const browser = await chromium.launch();

const openPage = async (provider, blocked) => {
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
  // Сторож записи ставится первым: последняя подмена отвечает первой.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route
      .fulfill({ status: 501, json: { error: 'qa: запись закрыта' } })
      .catch(() => undefined);
  });
  await bypassOnboarding(page, { provider });
  return { page, context };
};

/** Вставка или бросок файлов в поле — теми же событиями, что шлёт браузер. */
const deliver = (field, kind, names) =>
  field.evaluate(
    async (element, { b64, kind: way, names: fileNames }) => {
      const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
      const make = () => {
        const data = new DataTransfer();
        for (const name of fileNames)
          data.items.add(new File([bytes], name, { type: 'image/png' }));
        return data;
      };
      if (way === 'paste-twice') {
        // Большой снимок: ужатие до предела модели идёт заметное время, и
        // вторая вставка приходит, пока первая ещё летит, — но уже после
        // перерисовки, которую вызвала первая (так и бывает у человека).
        const canvas = document.createElement('canvas');
        canvas.width = 4000;
        canvas.height = 3000;
        const paint = canvas.getContext('2d');
        const gradient = paint.createLinearGradient(0, 0, 4000, 3000);
        gradient.addColorStop(0, '#3366cc');
        gradient.addColorStop(1, '#cc6633');
        paint.fillStyle = gradient;
        paint.fillRect(0, 0, 4000, 3000);
        const big = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        element.focus();
        const half = Math.ceil(fileNames.length / 2);
        for (const part of [fileNames.slice(0, half), fileNames.slice(half)]) {
          const data = new DataTransfer();
          for (const name of part) data.items.add(new File([big], name, { type: 'image/png' }));
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        }
        return {};
      }
      // Бросок: отменено ли действие браузера по умолчанию (открыть файл).
      const prevented = {};
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, {
          dataTransfer: make(),
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        prevented[type] = event.defaultPrevented;
      }
      return prevented;
    },
    { b64: PNG_B64, kind, names },
  );

// ── F-92: двойной Enter в чате чужого CLI ────────────────────────────────────
if (wants('send')) {
  console.log('\n— чат чужого CLI: отправка с картинкой');
  const blocked = [];
  const stored = [];
  const sent = [];
  const { page, context } = await openPage('codex', blocked);
  const chat = {
    id: 'qa-img',
    providerId: 'codex',
    title: 'QA картинки',
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
    workdir: process.cwd(),
  };
  await page.route('**/api/provider-runner', (route) =>
    route
      .fulfill({ json: { providerId: 'codex', providerName: 'Codex', mode: 'cli' } })
      .catch(() => undefined),
  );
  await page.route('**/api/provider-chat/chats', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [chat] }).catch(() => undefined)
      : route.fallback(),
  );
  await page.route(`**/api/provider-chat/chats/${chat.id}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { ...chat, messages: [] } }).catch(() => undefined)
      : route.fallback(),
  );
  await page.route(`**/api/provider-chat/chats/${chat.id}/status`, (route) =>
    route.fulfill({ json: { chatId: chat.id, isRunning: false } }).catch(() => undefined),
  );
  await page.route(`**/api/provider-chat/chats/${chat.id}/stream`, (route) =>
    route
      .fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': ping\n\n',
      })
      .catch(() => undefined),
  );
  await page.route(`**/api/provider-chat/chats/${chat.id}/send`, (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    return route
      .fulfill({
        json: { message: { id: `u${sent.length}`, role: 'user', content: body.text, at } },
      })
      .catch(() => undefined);
  });
  // Склад картинок отвечает медленно — как на большом снимке.
  await page.route('**/api/media/agent-files', async (route) => {
    const body = route.request().postDataJSON();
    stored.push(body.images.length);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return route
      .fulfill({
        json: {
          files: body.images.map((image, i) => ({ name: image.name, path: `C:/qa/${i}.png` })),
        },
      })
      .catch(() => undefined);
  });

  await page.goto(`${BASE}/chat`);
  const input = page.getByRole('textbox', { name: 'Сообщение провайдеру…' });
  await input.waitFor({ timeout: 30_000 });
  await page
    .locator('[data-image-attach-input]')
    .first()
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('[data-image-chip]').first().waitFor({ timeout: 10_000 });
  await input.fill('Посмотри на снимок');
  await input.press('Enter');
  await page.waitForTimeout(100);
  await input.press('Enter');
  // Пока картинка кладётся, человек пишет следующее.
  await input.press('End');
  await input.type(' и ещё');
  await page.waitForTimeout(2_500);
  check(stored.length === 1, 'картинка положена к панели один раз', String(stored.length));
  check(sent.length === 1, 'сообщение ушло один раз', String(sent.length));
  check(
    sent[0]?.text === 'Посмотри на снимок' && (sent[0]?.attachments ?? []).length === 1,
    'ушёл текст до Enter и путь картинки',
    JSON.stringify(sent[0] ?? {}),
  );
  const left = await input.inputValue();
  check(left === 'и ещё', 'набранное за время отправки осталось в поле, ушедшее — нет', left);
  check((await page.locator('[data-image-chip]').count()) === 0, 'ушедшая картинка убрана из поля');
  check(blocked.length === 0, 'иных записей не было', blocked.join(', '));
  await context.close();
}

/** Агент панели с подменённым ходом; `hang` — ход не кончается (поле занято). */
const openAgent = async (blocked, runs, { hang = false } = {}) => {
  const { page, context } = await openPage(undefined, blocked);
  await page.route('**/api/agent/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/run')) {
      runs.push(route.request().postDataJSON());
      if (hang) return undefined;
      const frames = [
        { kind: 'start', conversationId: 'qa-img-conv', providerId: 'claude' },
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
    if (path.endsWith('/conversations/qa-img-conv')) {
      return route.fulfill({ status: 404, json: { error: 'not_found' } }).catch(() => undefined);
    }
    return route.fulfill({ json: [] }).catch(() => undefined);
  });
  await page.goto(`${BASE}/rules`);
  const win = page.locator('[data-panel-agent-window]');
  await page
    .locator('[data-panel-agent-window], [data-panel-agent-trigger]')
    .first()
    .waitFor({ timeout: 60_000 });
  if ((await win.count()) === 0) {
    await page.locator('[data-panel-agent-trigger]').evaluate((button) => button.click());
  }
  await win.waitFor({ timeout: 10_000 });
  const input = win.locator('[data-agent-input]');
  await input.waitFor();
  return { page, context, win, input };
};

// ── F-93: две быстрые вставки и предел восемь ─────────────────────────────────
if (wants('count')) {
  console.log('\n— агент панели: две вставки подряд');
  const blocked = [];
  const { page, context, win, input } = await openAgent(blocked, []);
  const names = Array.from({ length: 10 }, (_, i) => `p${i}.png`);
  await deliver(input, 'paste-twice', names);
  await page.waitForTimeout(6_000);
  const chips = await win.locator('[data-image-chip]').count();
  check(chips === 8, 'приложено восемь, не больше', String(chips));
  const refusal = win.locator('[data-image-refusal]');
  const text = (await refusal.count()) > 0 ? await refusal.innerText() : '';
  check(
    text.includes('p8.png') && text.includes('p9.png'),
    'две лишние названы в отказе',
    text.slice(0, 160),
  );
  check(blocked.length === 0, 'иных записей не было', blocked.join(', '));
  await context.close();
}

// ── F-94: бросок файла на занятое поле ───────────────────────────────────────
if (wants('drop')) {
  console.log('\n— агент панели: бросок на занятое поле');
  const blocked = [];
  const runs = [];
  const { page, context, win, input } = await openAgent(blocked, runs, { hang: true });
  await input.fill('Первый вопрос');
  await input.press('Enter');
  await page.waitForTimeout(800);
  check(runs.length === 1, 'ход идёт — поле занято', String(runs.length));
  await input.fill('Черновик следующего');
  const prevented = await deliver(input, 'drop', ['late.png']);
  check(
    prevented.dragover === true && prevented.drop === true,
    'бросок перехвачен — браузер не откроет файл вместо страницы',
    JSON.stringify(prevented),
  );
  await page.waitForTimeout(500);
  check(
    (await input.inputValue()) === 'Черновик следующего',
    'черновик цел',
    await input.inputValue(),
  );
  const refusal = win.locator('[data-image-refusal]');
  const text = (await refusal.count()) > 0 ? await refusal.innerText() : '';
  check(text.includes('late.png'), 'отказ сказан словами и называет файл', text.slice(0, 160));
  check((await win.locator('[data-image-chip]').count()) === 0, 'в занятое поле ничего не легло');

  // Обратная сторона: над свободным полем бросок прикладывает, как прежде.
  await context.close();
  const free = await openAgent(blocked, []);
  const accepted = await deliver(free.input, 'drop', ['free.png']);
  await free.win
    .locator('[data-image-chip]')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  check(
    accepted.drop === true && (await free.win.locator('[data-image-chip]').count()) === 1,
    'над свободным полем бросок прикладывает картинку',
    JSON.stringify(accepted),
  );
  check(blocked.length === 0, 'иных записей не было', blocked.join(', '));
  await free.context.close();
}

// ── F-334: размер сверх предела в отказе — не сам предел ─────────────────────
if (wants('size')) {
  console.log('\n— агент панели: картинка на байт больше предела');
  const blocked = [];
  const { context, win, input } = await openAgent(blocked, []);
  // Предел проверяется по размеру до чтения — содержимое неважно.
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }),
    );
    element.focus();
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const refusal = win.locator('[data-image-refusal]');
  await refusal.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const text = (await refusal.count()) > 0 ? await refusal.innerText() : '';
  check(
    text.includes('huge.png') && text.includes('20,1 МБ'),
    'в отказе настоящий размер, не округлённый до предела',
    text.slice(0, 200),
  );
  if (process.env.SHOTS) await win.screenshot({ path: `${process.env.SHOTS}/F-334-size.png` });
  check(blocked.length === 0, 'иных записей не было', blocked.join(', '));
  await context.close();
}

// ── F-341: окно закрыто, пока картинка ещё ужимается ─────────────────────────
if (wants('unmount')) {
  console.log('\n— агент панели: закрыть окно посреди ужатия');
  const blocked = [];
  const { page, context, win, input } = await openAgent(blocked, []);
  // Живые object URL считаются на странице: созданный после ухода поля никто
  // уже не отзовёт — он держит картинку в памяти до F5.
  await page.evaluate(() => {
    const live = new Set();
    window.__qaLiveUrls = live;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
  });
  // Большой снимок и закрытие в том же такте, что вставка: ужатие ещё идёт,
  // когда поле уже снято.
  await input.evaluate(async (element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 6000;
    canvas.height = 4500;
    const paint = canvas.getContext('2d');
    const gradient = paint.createLinearGradient(0, 0, 6000, 4500);
    gradient.addColorStop(0, '#3366cc');
    gradient.addColorStop(1, '#cc6633');
    paint.fillStyle = gradient;
    paint.fillRect(0, 0, 6000, 4500);
    const big = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new DataTransfer();
    for (const name of ['u1.png', 'u2.png']) {
      data.items.add(new File([big], name, { type: 'image/png' }));
    }
    element.focus();
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    const win = element.closest('[data-panel-agent-window]');
    win.querySelector('header button[aria-label="Закрыть"]').click();
  });
  await win.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  check((await win.count()) === 0, 'окно агента закрыто — поле размонтировано');
  await page.waitForTimeout(6_000);
  const live = await page.evaluate(() => window.__qaLiveUrls.size);
  check(live === 0, 'после ухода поля ни одного неотозванного object URL', String(live));
  check(blocked.length === 0, 'иных записей не было', blocked.join(', '));
  await context.close();
}

await browser.close();
console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
