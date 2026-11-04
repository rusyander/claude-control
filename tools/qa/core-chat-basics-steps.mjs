/**
 * Основы чата `/chat` на настоящей дороге (этап 10, перенос `check-chat-basics`): продолжение
 * разговора идёт задачей ядра, CLI — настоящий claude, подменена только модель (заглушка в процессе
 * проверки). Свидетельство — что ДОШЛО до модели (тела запросов заглушки) и что видно человеку.
 *
 * - chat-001: поле пустеет сразу, слово встаёт в ленту, ход двумя запросами к модели — первая часть
 *   ответа видна, пока ход ещё идёт; после F5 обе части на месте, разговор в списке слева; отказ
 *   сервера возвращает набранное в поле;
 * - chat-005: Sonnet и «Низкая» в шапке доходят до модели (`model` и усилие в теле запроса);
 * - chat-003: PNG и PDF — две карточки над полем, оба вложения в сообщении, модель получила их байты
 *   (размер картинки и число страниц посчитаны из тела запроса), читала копии ядра;
 * - chat-009: «prompt is too long» от модели — карточка ошибки словами панели, сырой текст CLI ниже.
 *
 * Модуль без своего стенда: шаги зовёт `check-core-chat.mjs` (`panelChat`), ответы модели —
 * `basicsReply` из его сценария.
 */
import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

// ── Файлы вложений ────────────────────────────────────────────────────────────────────────────

/** CRC32 для чанков PNG — без зависимостей. */
function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Настоящий PNG 3×2 (RGB): заголовок, данные, конец. */
export function tinyPng() {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.from([
    0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0, 0, 0, 0, 0, 0,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PDF из двух страниц — ровно столько, сколько нужно, чтобы их сосчитать. */
export const TWO_PAGE_PDF = [
  '%PDF-1.4',
  '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
  '2 0 obj <</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>> endobj',
  '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj',
  '4 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj',
  'trailer <</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

export const ATTACH_ANSWER = 'Картинка PNG 3×2, в PDF страниц: 2';

// ── Ответы модели ─────────────────────────────────────────────────────────────────────────────

/** Байтовые источники (картинка, документ) в блоках сообщений — где бы CLI их ни положил. */
function sourcesIn(messages) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return undefined;
    if (node.source?.type === 'base64' && typeof node.source.data === 'string') {
      out.push({
        type: node.type,
        media: node.source.media_type,
        bytes: Buffer.from(node.source.data, 'base64'),
      });
    }
    return walk(node.content);
  };
  for (const m of messages) walk(m?.content);
  return out;
}

const pngSize = (bytes) =>
  bytes.subarray(1, 4).toString('latin1') === 'PNG'
    ? `${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}`
    : null;

function pdfPages(bytes) {
  const text = bytes.toString('latin1');
  if (!text.startsWith('%PDF')) return null;
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

/** Что модель получила байтами: размер картинки и число страниц — или перечень увиденного. */
export function attachmentFacts(messages) {
  const sources = sourcesIn(messages);
  const size = sources.map((s) => pngSize(s.bytes)).find(Boolean);
  const pages = sources.map((s) => pdfPages(s.bytes)).find((n) => n !== null && n !== undefined);
  if (size && pages !== undefined) return `Картинка PNG ${size}, в PDF страниц: ${pages}`;
  const seen = sources.map((s) => `${s.type}/${s.media}/${s.bytes.length}б`).join(', ');
  return `вложения дошли не все: ${seen || 'байтов нет'}`;
}

const hasToolResult = (messages) =>
  messages.some(
    (m) =>
      m?.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((b) => b?.type === 'tool_result'),
  );

/** Пути вложений в слове человека: строки блока вложений панели, картинка и PDF. */
const attachedPaths = (said) =>
  said
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter((line) => /\.(png|pdf)$/i.test(line));

/**
 * Ответ модели на слова основ чата — `undefined`, если слово не их. `after` — сообщения после
 * слова человека (результаты инструментов этого хода), `readCall` — вызов чтения тем инструментом,
 * что предложил CLI.
 */
export function basicsReply({ said, after, tools, file, readCall }) {
  const turn = /ход-(\d+)/.exec(said)?.[1];
  // Ход двумя запросами: первая часть ответа и чтение файла; вторая часть придержана — между ними
  // человек видит промежуточное состояние хода.
  if (/два шага/.test(said)) {
    if (hasToolResult(after)) return { text: `конец хода-${turn}`, holdMs: 6_000 };
    const call = readCall(tools, file);
    return call ? { text: `начало хода-${turn}`, tool: call } : { text: 'нет инструмента чтения' };
  }
  // Вложения: прочитать оба файла копий ядра, затем назвать то, что пришло байтами.
  if (/вложения/.test(said)) {
    if (hasToolResult(after)) return { text: attachmentFacts(after) };
    const calls = attachedPaths(said)
      .map((path) => readCall(tools, path))
      .filter(Boolean);
    return calls.length > 0 ? { tools: calls } : { text: `путей вложений нет: ${said}` };
  }
  // Переполненный контекст — ответ модели 400, как у настоящего API.
  if (/сломайся/.test(said)) {
    return {
      error: {
        status: 400,
        type: 'invalid_request_error',
        message: 'prompt is too long: 231000 tokens > 200000 maximum',
      },
    };
  }
  return undefined;
}

// ── Шаги на экране ────────────────────────────────────────────────────────────────────────────

/** Усилие в теле запроса — там, где его кладёт CLI. */
const effortOf = (body) =>
  body?.output_config?.effort ?? body?.thinking?.effort ?? body?.reasoning_effort ?? body?.effort;

/** Главный запрос хода: слово с этим ходом и инструменты CLI (служебные запросы без них). */
const turnBody = (bodies, mark) =>
  bodies.find((b) => b.said.includes(mark) && (b.body?.tools?.length ?? 0) > 0)?.body;

/** chat-005, до хода, что начнёт новую задачу ядра: Sonnet и «Низкая» в шапке чата. */
export async function pickModel({ page, check, wait }) {
  const modelSelect = page.getByRole('combobox', { name: 'Модель' });
  const sonnet = await modelSelect
    .locator('option')
    .evaluateAll((options) => options.find((o) => /sonnet/i.test(o.textContent ?? ''))?.value);
  check('/chat: в выборе модели есть Sonnet', Boolean(sonnet));
  if (sonnet) await modelSelect.selectOption(sonnet);
  const depth = page.getByRole('combobox', { name: 'Глубина продумывания' });
  await depth.selectOption({ label: 'Низкая' });
  await wait(400);
  const label = await modelSelect.evaluate((node) => node.selectedOptions[0]?.textContent ?? '');
  const depthLabel = await depth.evaluate((node) => node.selectedOptions[0]?.textContent ?? '');
  check(
    `/chat: в шапке Sonnet и «Низкая» (${label}, ${depthLabel})`,
    /sonnet/i.test(label) && depthLabel === 'Низкая',
  );
}

/** chat-005, после хода: модель и усилие дошли до модели в теле запроса. */
export function modelReached({ check, bodies, mark }) {
  const body = turnBody(bodies, mark);
  const effort = effortOf(body);
  const keys = body ? Object.keys(body).join(',') : 'запроса нет';
  check(
    `/chat: ход выполнен Sonnet — модель в запросе (${body?.model})`,
    /sonnet/i.test(body?.model ?? ''),
    keys,
  );
  check(
    `/chat: глубина «Низкая» дошла до модели (усилие ${effort})`,
    effort === 'low',
    `${keys}; output_config ${JSON.stringify(body?.output_config)}; thinking ${JSON.stringify(body?.thinking)}`,
  );
}

/** Пути, которые модель велела прочитать в этом ходе (вызовы инструмента в ответах модели). */
function readPaths(bodies, mark) {
  const paths = new Set();
  for (const { said, body } of bodies) {
    if (!said.includes(mark)) continue;
    for (const m of body?.messages ?? []) {
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        const path = b?.type === 'tool_use' ? (b.input?.file_path ?? b.input?.path) : undefined;
        if (typeof path === 'string' && /\.(png|pdf)$/i.test(path)) paths.add(path);
      }
    }
  }
  return [...paths];
}

/**
 * chat-001, chat-003, chat-009 — после основных ходов `panelChat`, в том же разговоре: живой шаг
 * ядра, вложения его копиями, ошибка модели последней (ход после неё не нужен).
 */
export async function basicsSteps(ctx) {
  const { stand, page, input, check, wait, bodies, conv, taskId, shoot, dismissAccess } = ctx;
  const count = (text) => page.getByText(text).count();
  const shown = (text, seconds) =>
    page
      .getByText(text)
      .first()
      .waitFor({ timeout: seconds * 1000 })
      .then(() => true)
      .catch(() => false);
  const stopButton = page.getByRole('button', { name: 'Остановить' });

  // chat-001: поле пустеет сразу, слово в ленте, промежуточное состояние хода.
  const said11 = 'ход-11: два шага';
  await input.fill(said11);
  await input.press('Enter');
  await wait(250);
  check('/chat: поле пустеет в тот же миг', (await input.inputValue()) === '');
  check('/chat: слово человека встало в ленту', await shown(said11, 30));
  let partial = false;
  for (let i = 0; i < 240 && !partial; i++) {
    const start = await count('начало хода-11');
    const end = await count('конец хода-11');
    if (end > 0) break;
    partial = start > 0 && (await stopButton.count()) > 0;
    if (!partial) await wait(250);
  }
  if (partial) await shoot(page, 'panel-chat-core-partial');
  check('/chat: промежуточное состояние — первая часть ответа видна, ход ещё идёт', partial);
  check('/chat: ход кончился второй частью ответа', await shown('конец хода-11', 60));
  for (let i = 0; i < 40 && (await stopButton.count()) > 0; i++) await wait(250);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor({ timeout: 60_000 });
  await dismissAccess(page);
  check(
    '/chat: после F5 разговор на месте — обе части ответа',
    (await shown('начало хода-11', 30)) && (await shown('конец хода-11', 30)),
  );
  const row = page.locator(`[data-chat-pin="${conv}"]`);
  check(
    '/chat: разговор в списке слева',
    await row
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
  );

  // chat-003: две карточки над полем, вложения доходят до модели байтами копий ядра.
  const png = join(stand.root, 'qa-picture.png');
  const pdf = join(stand.root, 'qa-two-pages.pdf');
  writeFileSync(png, tinyPng());
  writeFileSync(pdf, TWO_PAGE_PDF, 'latin1');
  const attach = page.locator('input[data-chat-attach-input]');
  await attach.setInputFiles(png);
  await wait(500);
  await attach.setInputFiles(pdf);
  await wait(500);
  check(
    '/chat: две карточки вложений над полем',
    (await count('qa-picture.png')) > 0 && (await count('qa-two-pages.pdf')) > 0,
  );
  await input.fill('ход-12: вложения');
  await input.press('Enter');
  const answered = await shown(ATTACH_ANSWER, 120);
  const lastBody = bodies.filter((b) => b.said.includes('ход-12')).at(-1)?.body;
  check(
    '/chat: модель назвала размер картинки и число страниц PDF — байты дошли',
    answered,
    lastBody ? attachmentFacts(lastBody.messages ?? []) : 'запроса с ходом-12 нет',
  );
  const files = (
    await page
      .getByRole('list', { name: 'Приложенные файлы' })
      .last()
      .innerText()
      .catch(() => '')
  ).toLowerCase();
  check(
    '/chat: в сообщении видны оба вложения',
    files.includes('qa-picture') && files.includes('qa-two-pages'),
    files,
  );
  // Копии ядра — сосед дома ядра, не внутри него (`core-home.ts`, запрет CLI на дом закрыл бы их):
  // `<родитель дома>/<корень копий>/<имя дома>/<задача>/`.
  const read = readPaths(bodies, 'ход-12');
  const copyRoots = ['agentdeck-attachments', 'attachments', 'att'].map((name) =>
    `${resolve(dirname(stand.coreHome), name, basename(stand.coreHome), taskId)}${sep}`.toLowerCase(),
  );
  check(
    `/chat: модель читала копии ядра этой задачи, не файлы панели (${read.length})`,
    read.length === 2 &&
      read.every((p) => copyRoots.some((root) => resolve(p).toLowerCase().startsWith(root))),
    `${read.join(' | ')} — ждали под ${copyRoots[0]}`,
  );
  await shoot(page, 'panel-chat-core-attachments');
  for (let i = 0; i < 40 && (await stopButton.count()) > 0; i++) await wait(250);

  // chat-001: отказ сервера возвращает набранное. Отказ задержан — иначе текст вернулся бы до замера.
  const refusedText = 'отказ: этот текст обязан вернуться';
  const refuse = async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await wait(1500);
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"отказ проверки"}',
    });
  };
  await page.route('**/api/chat/send', refuse);
  await input.fill(refusedText);
  await input.press('Enter');
  await wait(250);
  check('/chat: отказ — до ответа сервера поле уже пустое', (await input.inputValue()) === '');
  let back = '';
  for (let i = 0; i < 60 && back !== refusedText; i++) {
    await wait(100);
    back = await input.inputValue();
  }
  check('/chat: отказ — набранное вернулось в поле', back === refusedText, back);
  await page.unroute('**/api/chat/send', refuse);
  await input.fill('');

  // chat-009: переполненный контекст — объяснение словами панели, сырой текст CLI ниже.
  await input.fill('ход-13: сломайся');
  await input.press('Enter');
  const card = page.locator('[data-chat-error]').last();
  const carded = await card
    .waitFor({ timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  check('/chat: в ленте карточка ошибки', carded);
  const explained = carded
    ? await card
        .locator('[data-chat-error-explained]')
        .innerText()
        .catch(() => '')
    : '';
  const whole = carded ? await card.innerText() : '';
  check(
    '/chat: объяснение по-русски — что случилось и что сделать',
    /[а-яё]/i.test(explained) && /контекст/i.test(explained),
    explained,
  );
  const raw = whole.search(/prompt is too long/i);
  check(
    '/chat: сырой текст CLI рядом, ниже объяснения, а не вместо',
    raw >= 0 && whole.indexOf(explained) < raw,
    whole.slice(0, 400),
  );
  await shoot(page, 'panel-chat-core-error');
}
