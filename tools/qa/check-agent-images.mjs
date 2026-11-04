/**
 * Картинки в КАЖДОМ поле агента (12b): кнопка, вставка Ctrl+V и перетаскивание —
 * в агенте панели, помощнике формы, помощнике структуры и чате Claude, в светлой и
 * тёмной теме. Свидетельство — то, что ДОШЛО ДО МОДЕЛИ: блоки `image` в запросе,
 * который настоящий `claude` сессии ядра отправил заглушке, сверяются байт в байт с
 * приложенными (след заглушки, файл JSON-строк).
 *
 * Что гоняется (этап 10, F2b): одноразовая панель со своим ядром, НАСТОЯЩИЙ `claude` из
 * PATH и модель — сценарий над `packages/stub-model` в этом процессе (своего кода SSE
 * нет). Подменена только модель — внешняя граница, сеть к вендору:
 *   - агент панели: окно → POST /api/agent/run → вопрос ядра «ask» с картинками → `claude`
 *     (потоковый ввод) → модель; сценарий агента — `scenarios/panel-agent.mjs`;
 *   - помощник формы и структуры: окно → /api/assist, /api/resources/…/assist → лёгкая
 *     сессия ядра с картинками → `claude` → модель;
 *   - чат Claude: поле → POST отправки (файл в теле) → панель кладёт файл в папку чата и
 *     называет путь → ход ядра → `claude` → модель зовёт Read по пути → картинка
 *     возвращается модели блоком `image` в результате инструмента.
 * Профиль «Ассистент панели» указывает на заглушку (маршрут ядра `api-key:endpoint:stub`),
 * личный settings.json стенда — её адрес и ключ (ход чата).
 *
 * Снято решением: ассистент шага группы (F1 убрал форму групп и шаги панели — группы
 * ведёт ядро) и поле чата чужого CLI (F2c: тот чат только читает прежние разговоры).
 *
 * Отказы: не картинка, больше 20 МБ (с настоящим размером), больше восьми.
 * Ужатие: снимок 3200×1800 доходит до модели длинной стороной не больше 1568.
 * Ширина окна агента: перетаскивание, клавиатура, память через перезагрузку,
 * границы, узкий экран без ручки (модель и ядро не нужны — стенд без них).
 *
 * Стенд одноразовый (`throwaway-stand.mjs`): свой дом, свой PATH, ничего
 * человека не трогает. Нет `claude` в PATH — «не проверено» (код 2) для разделов с
 * моделью. Запуск: `node tools/qa/check-agent-images.mjs
 * [--only panel,form,structure,chat,resize,refusals] [--shots <dir>]`.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { runPanelAgentOnCore } from './panel-agent-core-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import {
  decidePanelAgentStep,
  parsePanelAgentRequest,
} from '../../packages/stub-model/src/scenarios/panel-agent.mjs';

const argOf = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const only = argOf('--only') ? new Set(argOf('--only').split(',')) : undefined;
const wants = (name) => !only || only.has(name);
const SHOTS = argOf('--shots');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MODEL_SECTIONS = ['panel', 'form', 'structure', 'chat'];
const needsModel = MODEL_SECTIONS.some(wants);

// ── Картинки ────────────────────────────────────────────────────────────────

/** PNG заданного размера одним цветом — собран руками, без зависимостей. */
function makePng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Размер картинки по байтам (PNG или JPEG). */
function dimensionsOf(base64) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes[0] === 0x89) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  for (let at = 2; at < bytes.length - 9;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

const PNG_A = makePng(40, 30, [220, 40, 40]);
const PNG_B = makePng(30, 40, [40, 120, 220]);
const PNG_C = makePng(24, 24, [40, 180, 90]);
const PNG_BIG = makePng(3200, 1800, [250, 200, 20]);
const PATHS = [
  { way: 'button', png: PNG_A },
  { way: 'paste', png: PNG_B },
  { way: 'drop', png: PNG_C },
];

// ── Модель: сценарий над stub-model ─────────────────────────────────────────

/** Маркер списка вложений чата (`ATTACHMENTS_MARKER` контрактов, uploads.ts). */
const ATTACH_MARK = 'Приложенные файлы (прочитай их):';

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
      : '';
const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);
const userTextOf = (body) =>
  messagesOf(body)
    .filter((m) => m?.role === 'user')
    .map((m) => textOf(m.content))
    .join('\n');
/** Блоки `image` реплик человека (не результатов инструментов). */
const userImages = (messages) =>
  messages
    .filter((m) => m?.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((block) => block?.type === 'image'));
/** Блоки `image` внутри результатов инструментов (Read картинки в чате). */
const toolImages = (messages) =>
  messages
    .filter((m) => m?.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((block) => block?.type === 'tool_result'))
    .flatMap((block) =>
      Array.isArray(block.content) ? block.content.filter((part) => part?.type === 'image') : [],
    );
/** Форма разговора в запросе: роль, типы блоков, начало текста — где именно лежит реплика человека. */
const messagesShape = (messages) =>
  messages.map((m, i) => {
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'string' }];
    const kinds = blocks.map((block) =>
      block?.type === 'tool_use' ? `tool_use:${block.input?.file_path ?? block.name}` : block?.type,
    );
    const text = textOf(m?.content).replace(/\s+/g, ' ').slice(0, 160);
    return `#${i} ${m?.role} [${kinds.join(',')}] ${text}`;
  });
/** Результаты инструментов кратко: ошибка ли, типы частей, начало текста. */
const toolResultsBrief = (messages) =>
  messages
    .filter((m) => m?.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((block) => block?.type === 'tool_result'))
    .map((block) => {
      const parts = Array.isArray(block.content) ? block.content : [block.content];
      const kinds = parts.map((part) => (typeof part === 'string' ? 'text' : part?.type));
      return `tool_result error=${Boolean(block.is_error)} parts=${kinds.join(',')} ${textOf(block.content).slice(0, 300)}`;
    });
const hasToolResult = (message) =>
  message?.role === 'user' &&
  Array.isArray(message.content) &&
  message.content.some((block) => block?.type === 'tool_result');
/**
 * Картинки из результатов инструментов ПОСЛЕ последней реплики человека с меткой `mark`. Второй
 * ход того же чата несёт в истории картинку первого: без среза ожидание кончалось на первом же
 * запросе второго хода, до его Read, и проверка краснела на рабочем пути.
 */
const toolImagesAfter = (messages, mark) => {
  let at = -1;
  messages.forEach((m, i) => {
    if (m?.role === 'user' && !hasToolResult(m) && textOf(m.content).includes(mark)) at = i;
  });
  return at < 0 ? [] : toolImages(messages.slice(at + 1));
};

/**
 * Ответ модели по виду запроса. Число картинок, ДОШЕДШИХ в этот запрос, модель называет в
 * ответе (`images=N`) — его видно на экране, а сами байты проверка сверяет по следу.
 *   - агент панели (метка платформы ядра) — сценарий пакета `panel-agent`, ответ текстом;
 *   - помощник формы (`fill in the form "…"`) и структуры — JSON их вида без полей/файлов;
 *   - чат: в последней реплике человека — список вложений → вызов Read по первому пути;
 *     после результата инструмента — ответ с числом картинок в результатах этого хода.
 */
function imagesScript(ctx) {
  const body = ctx.request.body ?? {};
  const messages = messagesOf(body);
  const prompt = userTextOf(body);
  const own = userImages(messages).length;
  const offered = ctx.info.tools.map((tool) => tool.name);
  // Помощники — раньше агента: метку платформы ядро ставит на каждый вопрос «ask».
  if (/fill in the form "/.test(prompt)) {
    return { text: JSON.stringify({ reply: `QA-FORM: images=${own}`, fields: {} }) };
  }
  if (prompt.includes('You help build the structure')) {
    return { text: JSON.stringify({ reply: `QA-STRUCTURE: images=${own}`, files: [] }) };
  }
  // Чат — раньше агента: с доверенным слоем человека запрос хода чата разбирается и как вопрос
  // агента панели, а список вложений есть только в реплике чата.
  let at = -1;
  messages.forEach((m, i) => {
    if (m?.role === 'user' && !hasToolResult(m) && textOf(m.content).includes(ATTACH_MARK)) at = i;
  });
  if (at < 0) {
    const parsed = parsePanelAgentRequest(body, offered);
    if (parsed.current !== undefined) {
      return decidePanelAgentStep(async () => `QA-AGENT: images=${own}`, parsed);
    }
    return { text: 'stub side reply' };
  }
  const after = messages.slice(at + 1);
  if (after.some(hasToolResult)) return { text: `QA-CHAT: images=${toolImages(after).length}` };
  const listed = textOf(messages[at].content).split(ATTACH_MARK)[1] ?? '';
  const path = /^\s*-\s+(.+?)\s*$/m.exec(listed)?.[1];
  if (!path) return { text: 'QA-CHAT: no attachment path' };
  if (!offered.includes('Read')) return { text: `QA-CHAT: no Read (${offered.join(', ')})` };
  return { tool: { name: 'Read', args: { file_path: path } } };
}

/** След заглушки — файл вне репозитория и вне дома стенда; пишет пакет, читает проверка. */
const TRACE_DIR = mkdtempSync(join(tmpdir(), 'cc-agent-images-trace-'));
const TRACE = join(TRACE_DIR, 'trace.jsonl');
// Итог проверки — `process.exit` стенда: след уходит вместе с процессом.
process.on('exit', () => rmSync(TRACE_DIR, { recursive: true, force: true }));
/** Модельные запросы следа по порядку (ответы `route` и 404 в счёт не идут). */
const traced = () =>
  existsSync(TRACE)
    ? readFileSync(TRACE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.kind === 'model')
    : [];

/**
 * Запросы модели после отметки `since`, чей текст человека несёт `mark`, — когда появится
 * хоть один, отвечающий `ready` (по умолчанию — любой). Ждём до `timeoutMs`.
 */
async function requestsOf(
  since,
  mark,
  { ready = () => true, timeoutMs = 120_000, stop = () => false } = {},
) {
  let found = [];
  for (let t = 0; t < timeoutMs; t += 500) {
    found = traced()
      .slice(since)
      .filter((row) => userTextOf(row.body).includes(mark));
    if (found.some(ready) || stop()) return found;
    await wait(500);
  }
  return found;
}
/** Картинки реплики человека во всех запросах хода, у которых они есть. */
const imagesOfTurn = (rows) =>
  rows.map((row) => userImages(messagesOf(row.body))).filter((list) => list.length > 0);
const b64 = (block) => block?.source?.data ?? '';
/** Каждый запрос хода с картинками несёт ровно одну — эту, байт в байт; такой запрос есть. */
const sameImage = (rows, png) => {
  const lists = imagesOfTurn(rows);
  return (
    lists.length > 0 &&
    lists.every((list) => list.length === 1 && b64(list[0]) === png.toString('base64'))
  );
};
const imagesDetail = (rows) =>
  JSON.stringify({
    requests: rows.length,
    images: imagesOfTurn(rows).map((list) =>
      list.map((block) => `${block.source?.media_type} ${b64(block).length}b`),
    ),
  });

// ── Сценарий ────────────────────────────────────────────────────────────────

const seedSkill = ({ root, cfg }) => {
  mkdirSync(join(cfg, 'skills', 'qa-skill'), { recursive: true });
  writeFileSync(
    join(cfg, 'skills', 'qa-skill', 'SKILL.md'),
    '---\nname: qa-skill\ndescription: QA skill for images.\n---\n\nBody.\n',
    'utf8',
  );
  // Проект чата: каталог с git (чат проекта, как у человека).
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'repo\n', 'utf8');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'stand');
  git('config', 'user.email', 'stand@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Проект, которому человек уже доверился в Claude Code (как у всякого проекта в работе): без
  // отметки ядро ведёт слой человека «observe», и набор панели отказан до модели (plugin-carry).
  const globalPath = join(cfg, '.claude.json');
  const global = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, 'utf8')) : {};
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [] };
  const projects = { ...global.projects, [repo]: trusted, [realpathSync.native(repo)]: trusted };
  writeFileSync(globalPath, `${JSON.stringify({ ...global, projects }, null, 2)}\n`, 'utf8');
};

async function scenario(stand, check) {
  const repoDir = join(stand.root, 'repo');
  const browser = await chromium.launch();
  try {
    for (const scheme of ['light', 'dark']) {
      if (!MODEL_SECTIONS.some(wants) && scheme === 'dark') continue;
      console.log(`\n── Тема: ${scheme}`);
      const context = await browser.newContext({
        viewport: { width: 1400, height: 950 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const shot = async (name) => {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}_${scheme}.png`) });
      };

      /** Приложить картинку одним из трёх путей в поле `scope`/`field`. */
      const attachBy = async (way, scope, field, png, name) => {
        if (way === 'button') {
          await scope
            .locator('[data-image-attach-input], [data-chat-attach-input]')
            .first()
            .setInputFiles({ name, mimeType: 'image/png', buffer: png });
          return;
        }
        const payload = { b64: png.toString('base64'), name, way };
        await field.evaluate((element, { b64: data64, name: fileName, way: kind }) => {
          const bytes = Uint8Array.from(atob(data64), (char) => char.charCodeAt(0));
          const data = new DataTransfer();
          data.items.add(new File([bytes], fileName, { type: 'image/png' }));
          if (kind === 'paste') {
            element.focus();
            element.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
            );
            return;
          }
          for (const type of ['dragenter', 'dragover', 'drop']) {
            element.dispatchEvent(
              new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
            );
          }
        }, payload);
      };

      const settle = () => page.waitForLoadState('domcontentloaded');

      /**
       * Открыть окно агента. Панель помнит, что оно было открыто, и после
       * перезагрузки поднимает его сама — кнопки тогда нет, ждать её нельзя.
       */
      const openAgent = async (timeout = 120_000) => {
        const win = page.locator('[data-panel-agent-window]');
        await page
          .locator('[data-panel-agent-window], [data-panel-agent-trigger]')
          .first()
          .waitFor({ timeout });
        if ((await win.count()) === 0) {
          await page.locator('[data-panel-agent-trigger]').evaluate((button) => button.click());
        }
        await win.waitFor({ timeout: 10_000 });
        return win;
      };

      /** Дождаться, что совпадений стало больше `before`: ответы прошлых ходов уже на экране. */
      const waitForMore = async (locator, before, timeoutMs = 90_000) => {
        for (let t = 0; t < timeoutMs / 250 && (await locator.count()) <= before; t += 1) {
          await wait(250);
        }
        return (await locator.count()) > before;
      };

      // ── 1. Агент панели ────────────────────────────────────────────────────
      if (wants('panel')) {
        await page.goto(`${stand.webUrl}/rules`);
        await settle();
        const win = await openAgent();
        const input = win.locator('[data-agent-input]');
        await input.waitFor();
        for (const { way, png } of PATHS) {
          const name = way === 'paste' ? 'image.png' : `${way}-${scheme}.png`;
          await attachBy(way, win, input, png, name);
          const chip = win.locator('[data-image-chip]');
          const attached = await chip
            .first()
            .waitFor({ timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          check(`агент панели, ${way}: чип появился`, attached);
          const chipName = attached ? await chip.first().getAttribute('data-image-chip') : '';
          if (way === 'paste') {
            check(
              'вставка: безымянный снимок получил имя pasted-…',
              /^pasted-\d{8}-\d{6}\.png$/.test(chipName ?? ''),
              chipName ?? '',
            );
          }
          if (way === 'button') await shot('panel-agent-attached');
          const since = traced().length;
          // Любой новый ответ, не только верный: мутант без картинки должен
          // краснеть по тексту, а не ждать таймаута.
          const replies = win.getByText(/QA-AGENT: images=\d+/);
          const repliesBefore = await replies.count();
          const mark = `Что на снимке (${way}, ${scheme})?`;
          await input.fill(mark);
          await input.press('Enter');
          const rows = await requestsOf(since, mark, {
            ready: (row) => userImages(messagesOf(row.body)).length > 0,
          });
          check(
            `агент панели, ${way}: картинка дошла до модели блоком image байт в байт`,
            sameImage(rows, png),
            imagesDetail(rows),
          );
          check(
            `агент панели, ${way}: реплика модели называет картинку по-английски`,
            rows.some((row) => userTextOf(row.body).includes(`Attached images: ${chipName}`)),
          );
          const replied = await waitForMore(replies, repliesBefore);
          check(
            `агент панели, ${way}: ответ пришёл, чип снят, имя — в реплике`,
            replied &&
              (await replies.last().innerText()).includes('QA-AGENT: images=1') &&
              (await chip.count()) === 0 &&
              (await win.locator('[data-sent-images]').last().innerText()).includes(chipName),
            replied ? await replies.last().innerText() : 'ответа нет',
          );
        }
        await shot('panel-agent-sent');
        // Следующий ход без картинки — прежняя не едет повторно.
        {
          const since = traced().length;
          const replies = win.getByText('QA-AGENT: images=0');
          const before = await replies.count();
          const mark = `А без картинки (${scheme})?`;
          await input.fill(mark);
          await input.press('Enter');
          const rows = await requestsOf(since, mark);
          check(
            'агент панели: ход без картинки — в запросе модели ни одной картинки',
            rows.length > 0 && imagesOfTurn(rows).length === 0,
            imagesDetail(rows),
          );
          await waitForMore(replies, before);
        }

        // Ужатие большого снимка.
        if (scheme === 'light') {
          await attachBy('button', win, input, PNG_BIG, 'big.png');
          await win.locator('[data-image-chip]').first().waitFor({ timeout: 20_000 });
          const since = traced().length;
          const replies = win.getByText('QA-AGENT: images=1');
          const before = await replies.count();
          const mark = 'Большой снимок';
          await input.fill(mark);
          await input.press('Enter');
          const rows = await requestsOf(since, mark, {
            ready: (row) => userImages(messagesOf(row.body)).length > 0,
          });
          const block = imagesOfTurn(rows)[0]?.[0];
          const size = block ? dimensionsOf(b64(block)) : undefined;
          check(
            'снимок 3200×1800 дошёл до модели ужатым: длинная сторона ≤ 1568, пропорции те же',
            Boolean(size) &&
              Math.max(size.width, size.height) <= 1568 &&
              Math.abs(size.width / size.height - 3200 / 1800) < 0.01,
            `${JSON.stringify(size)} ${imagesDetail(rows)}`,
          );
          await waitForMore(replies, before);
        }

        // Отказы — в момент вложения, словами.
        if (wants('refusals') && scheme === 'light') {
          const refusal = win.locator('[data-image-refusal]');
          await win.locator('[data-image-attach-input]').setInputFiles({
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('x'),
          });
          await refusal.waitFor({ timeout: 5_000 }).catch(() => undefined);
          check(
            'не картинка: отказ с именем файла',
            (await refusal.count()) > 0 && (await refusal.innerText()).includes('notes.txt'),
          );
          const huge = Buffer.alloc(21 * 1024 * 1024);
          PNG_A.copy(huge);
          await win
            .locator('[data-image-attach-input]')
            .setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: huge });
          await page
            .waitForFunction(
              () =>
                document.querySelector('[data-image-refusal]')?.textContent?.includes('huge.png'),
              null,
              { timeout: 10_000 },
            )
            .catch(() => undefined);
          const hugeText = (await refusal.count()) > 0 ? await refusal.innerText() : '';
          check(
            'больше 20 МБ: отказ называет настоящий размер и предел',
            hugeText.includes('huge.png') && hugeText.includes('21') && hugeText.includes('20'),
            hugeText,
          );
          await shot('panel-agent-refusal');
          const nine = Array.from({ length: 9 }, (_, i) => ({
            name: `n${i}.png`,
            mimeType: 'image/png',
            buffer: PNG_C,
          }));
          await win.locator('[data-image-attach-input]').setInputFiles(nine);
          await page
            .waitForFunction(
              () => document.querySelectorAll('[data-image-chip]').length === 8,
              null,
              { timeout: 10_000 },
            )
            .catch(() => undefined);
          check(
            'девять картинок: приложено восемь, девятая названа в отказе',
            (await win.locator('[data-image-chip]').count()) === 8 &&
              (await refusal.innerText()).includes('n8.png'),
          );
          // Убрать всё крестиками — чипы снимаются по одному.
          for (let i = 0; i < 8; i += 1) {
            await win
              .getByRole('button', { name: /^Убрать картинку/ })
              .first()
              .click();
          }
          check('чипы убираются крестиком', (await win.locator('[data-image-chip]').count()) === 0);
        }
        await win
          .getByRole('button', { name: 'Закрыть', exact: true })
          .first()
          .click()
          .catch(() => undefined);
      }

      // ── 2. Помощник формы ──────────────────────────────────────────────────
      if (wants('form')) {
        await page.goto(`${stand.webUrl}/rules`);
        await settle();
        await page
          .getByRole('button', { name: /Добавить правило/ })
          .first()
          .click();
        const input = page.locator('[data-assistant-input]');
        await input.waitFor({ timeout: 20_000 });
        const scope = page.getByRole('dialog').filter({ has: input });
        for (const { way, png } of PATHS) {
          await attachBy(way, scope, input, png, `form-${way}.png`);
          await scope
            .locator('[data-image-chip]')
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          check(
            `помощник формы, ${way}: чип появился`,
            (await scope.locator('[data-image-chip]').count()) === 1,
          );
          if (way === 'button') await shot('form-assistant-attached');
          const since = traced().length;
          // Ответы прошлых путей уже на экране — ждём НОВЫЙ, а не любой.
          const replies = scope.getByText(/QA-FORM: images=\d+/);
          const repliesBefore = await replies.count();
          const mark = `заполни по снимку (${way}, ${scheme})`;
          await input.fill(mark);
          await input.press('Enter');
          const rows = await requestsOf(since, mark, {
            ready: (row) => userImages(messagesOf(row.body)).length > 0,
          });
          check(
            `помощник формы, ${way}: картинка дошла до модели блоком image байт в байт`,
            sameImage(rows, png),
            imagesDetail(rows),
          );
          check(
            `помощник формы, ${way}: ответ пришёл, чип снят`,
            (await waitForMore(replies, repliesBefore)) &&
              (await replies.last().innerText()).includes('QA-FORM: images=1') &&
              (await scope.locator('[data-image-chip]').count()) === 0,
            `ответов ${await replies.count()} (было ${repliesBefore}); ${(
              await scope
                .first()
                .innerText()
                .catch(() => '')
            )
              .replace(/\s+/g, ' ')
              .slice(-300)}`,
          );
        }
        await shot('form-assistant-sent');
        await page.keyboard.press('Escape');
      }

      // ── 3. Помощник структуры ──────────────────────────────────────────────
      if (wants('structure')) {
        await page.goto(`${stand.webUrl}/skills`);
        await settle();
        await page
          .getByRole('button', { name: 'Редактировать: qa-skill' })
          .first()
          .click({ timeout: 30_000 });
        const scope = page.locator('[data-structure-assistant]');
        await scope.waitFor({ timeout: 20_000 });
        const input = scope.locator('textarea');
        for (const { way, png } of PATHS) {
          await attachBy(way, scope, input, png, `tree-${way}.png`);
          await scope
            .locator('[data-image-chip]')
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          check(
            `помощник структуры, ${way}: чип появился`,
            (await scope.locator('[data-image-chip]').count()) === 1,
          );
          if (way === 'button') {
            await scope.scrollIntoViewIfNeeded();
            await shot('structure-assistant-attached');
          }
          const since = traced().length;
          const mark = `собери по схеме (${way}, ${scheme})`;
          await input.fill(mark);
          await scope.getByRole('button', { name: 'Собрать' }).click();
          const rows = await requestsOf(since, mark, {
            ready: (row) => userImages(messagesOf(row.body)).length > 0,
          });
          check(
            `помощник структуры, ${way}: картинка дошла до модели блоком image байт в байт`,
            sameImage(rows, png),
            imagesDetail(rows),
          );
          // Ответ прошлого пути остаётся на экране, а чип снимается только при
          // успехе — конец хода виден по снятому чипу, не по тексту ответа.
          const chips = scope.locator('[data-image-chip]');
          for (let t = 0; t < 360 && (await chips.count()) > 0; t += 1) await wait(250);
          check(
            `помощник структуры, ${way}: ответ пришёл, чип снят`,
            (await scope.getByText('QA-STRUCTURE: images=1').count()) > 0 &&
              (await chips.count()) === 0,
            // Что именно не сошлось: ответ, чип или оба (под нагрузкой ход дольше 90 с).
            JSON.stringify({
              replies: await scope.getByText('QA-STRUCTURE: images=1').count(),
              chips: await chips.count(),
              requests: rows.length,
            }),
          );
        }
        // Отказ сервера (F-175): причина словами сервера одной строкой у
        // помощника, а не общий «не сохранилось» плюс тост с той же причиной.
        const reason = 'Картинок больше восьми — приложите не больше восьми.';
        await page.route('**/api/resources/**/assist', (route) =>
          route.fulfill({ status: 400, json: { error: reason } }),
        );
        await input.fill('собери по схеме (отказ)');
        await scope.getByRole('button', { name: 'Собрать' }).click();
        await scope
          .getByText(reason)
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        await wait(800);
        const inScope = await scope.getByRole('alert').filter({ hasText: reason }).count();
        const onPage = await page.getByText(reason).count();
        check(
          `помощник структуры: отказ сервера назван у помощника и один раз (${inScope}/${onPage})`,
          inScope === 1 && onPage === 1,
        );
        await shot('structure-assistant-refused');
        await page.unroute('**/api/resources/**/assist');
        await page.keyboard.press('Escape');
      }

      // ── 4. Чат Claude: файл в папке чата → Read → картинка у модели ─────────
      if (wants('chat')) {
        const chatPage = await context.newPage();
        chatPage.on('pageerror', (error) => errors.push(error.message));
        const posts = [];
        chatPage.on('request', (request) => {
          if (request.method() === 'POST' && /\/api\/chat\//.test(request.url())) {
            try {
              posts.push(request.postDataJSON());
            } catch {
              // не JSON
            }
          }
        });
        // Ответы чата и ядра — в подробности провала: ход, не дошедший до модели, назван.
        const answers = [];
        chatPage.on('response', (response) => {
          const url = response.url();
          if (response.request().method() !== 'POST' || !/\/api\/(chat|core)\//.test(url)) return;
          void response
            .body()
            .then((bytes) => {
              const text = bytes.toString('utf8');
              answers.push(`${response.status()} ${new URL(url).pathname} ${text.slice(0, 400)}`);
            })
            .catch(() => answers.push(`${response.status()} ${new URL(url).pathname}`));
        });
        /** Ход чата кончился ошибкой (кадр `error` потока отправки) — ждать модель незачем. */
        const turnFailed = (from) =>
          answers.slice(from).some((line) => /"kind":"error"/.test(line));
        /**
         * Причина отказа, которой нет в кадре: строки журнала панели о ходе чата через ядро и
         * хвост журнала последней задачи ядра (без событий инструментов и расхода).
         */
        const coreChatLog = () => {
          const panel = stand
            .log()
            .split('\n')
            .filter((line) => /core chat:/.test(line))
            .slice(-3);
          const tasksDir = join(stand.coreHome, 'tasks');
          const tasks = existsSync(tasksDir) ? readdirSync(tasksDir).sort() : [];
          const last = tasks.at(-1);
          const file = last && readdirSync(join(tasksDir, last)).find((f) => f.endsWith('.jsonl'));
          const journal = file
            ? readFileSync(join(tasksDir, last, file), 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .filter((row) => row.kind !== 'tool.event' && row.kind !== 'turn.usage')
                .slice(-8)
                .map((row) => `${row.kind} ${JSON.stringify(row.data ?? {})}`)
            : [];
          return [...panel, ...journal].map((line) => line.slice(0, 600));
        };
        await chatPage.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
        await chatPage.evaluate((path) => {
          const tabId = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          localStorage.setItem(
            'agentdeck:workspace',
            JSON.stringify({
              projectTabs: [{ id: tabId, path, name: 'repo' }],
              activeTabId: tabId,
              views: {},
            }),
          );
        }, repoDir);
        await chatPage.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
        const input = chatPage.locator('textarea[data-chat-input]');
        await input.waitFor({ timeout: 90_000 });
        const blocking = chatPage.getByRole('dialog').filter({ hasText: 'нужен доступ' });
        await blocking
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        if ((await blocking.count()) > 0) {
          await blocking.first().getByRole('button', { name: 'Закрыть' }).first().click();
        }
        const scope = chatPage.locator('body');
        for (const { way, png } of PATHS) {
          // Снимок из буфера приходит безымянным `image.png` — чат даёт ему имя pasted-…
          const name = way === 'paste' ? 'image.png' : `chat-${way}.png`;
          await attachBy(way, scope, input, png, name);
          const chipName = way === 'paste' ? /^Удалить: pasted-/ : `Удалить: ${name}`;
          const chip = chatPage.getByRole('button', { name: chipName });
          await chip
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          check(`чат Claude, ${way}: чип вложения появился`, (await chip.count()) === 1);
          const before = posts.length;
          const answered = answers.length;
          const since = traced().length;
          const replies = chatPage.getByText(/QA-CHAT: images=\d+/);
          const repliesBefore = await replies.count();
          const mark = `что на снимке (${way}, ${scheme})`;
          await input.fill(mark);
          await input.press('Enter');
          // Ждём именно отправку с файлами: другой POST чата (служебный) мог
          // прийти раньше и закончить ожидание пустым.
          const sent = () => posts.slice(before).flatMap((body) => body?.files ?? []);
          for (let t = 0; t < 40 && sent().length === 0; t += 1) await wait(250);
          const files = sent();
          check(
            `чат Claude, ${way}: картинка ушла в теле отправки байт в байт`,
            files.some((file) => file.base64 === png.toString('base64')),
            JSON.stringify({
              posts: posts.length - before,
              files: files.map((file) => file.name),
              chips: await chatPage.locator('[aria-label^="Удалить: "]').count(),
            }),
          );
          // Модель видит путь в папке чата, зовёт Read — картинка возвращается ей блоком image.
          const rows = await requestsOf(since, mark, {
            ready: (row) => toolImagesAfter(messagesOf(row.body), mark).length > 0,
            timeoutMs: 180_000,
            stop: () => turnFailed(answered),
          });
          const asked = rows.some((row) => userTextOf(row.body).includes(ATTACH_MARK));
          const failed = turnFailed(answered);
          check(
            `чат Claude, ${way}: ход дошёл до модели, ей назван файл вложения`,
            asked && !failed,
            [imagesDetail(rows), ...answers.slice(answered), ...coreChatLog()].join('\n    '),
          );
          if (failed) {
            // Ход отказан до модели: остальные пути упёрлись бы в тот же отказ — раздел кончен.
            console.log('  - чат Claude: остальные пути не проверены — ход отказан до модели');
            break;
          }
          const got = rows.flatMap((row) => toolImagesAfter(messagesOf(row.body), mark));
          const reached = check(
            `чат Claude, ${way}: картинка дошла до модели блоком image байт в байт (Read)`,
            got.length > 0 && got.every((block) => b64(block) === png.toString('base64')),
            got.length > 0
              ? JSON.stringify(
                  got.map((block) => ({
                    type: block.source?.media_type,
                    len: b64(block).length,
                    size: dimensionsOf(b64(block)),
                  })),
                )
              : // Картинки нет — что вернул Read вместо неё (отказ, ошибка, текст) и что видело ядро.
                [
                  `requests=${rows.length}`,
                  ...rows.flatMap((row) => toolResultsBrief(messagesOf(row.body))),
                  ...rows.flatMap((row) => messagesShape(messagesOf(row.body))),
                  ...answers.slice(answered),
                  ...coreChatLog(),
                ].join('\n    '),
          );
          const replied = await waitForMore(replies, repliesBefore, 120_000);
          check(
            `чат Claude, ${way}: ответ модели на экране называет картинку`,
            replied && (await replies.last().innerText()).includes('QA-CHAT: images=1'),
            replied ? await replies.last().innerText() : 'ответа нет',
          );
          if (!reached) {
            // Картинка не дошла одним путём — прочие упрутся в ту же причину, по 5 мин ожидания каждый.
            console.log(
              '  - чат Claude: остальные пути не проверены — картинка не дошла до модели',
            );
            break;
          }
          if (way === 'button' && SHOTS) {
            await chatPage
              .screenshot({ path: join(SHOTS, `chat_${scheme}.png`) })
              .catch(() => undefined);
          }
        }
        await chatPage.close();
      }

      // ── 5. Ширина окна агента ──────────────────────────────────────────────
      if (wants('resize') && scheme === 'light') {
        await page.goto(`${stand.webUrl}/rules`);
        await settle();
        await page.evaluate(() => localStorage.removeItem('agentdeck:panel-agent-dock-width'));
        await page.reload();
        const win = await openAgent();
        const handle = page.getByRole('separator', { name: 'Ширина окна агента' });
        await handle.waitFor({ timeout: 10_000 });
        const dockWidth = async () => Math.round((await win.boundingBox()).width);
        check('по умолчанию 440 px', (await dockWidth()) === 440, String(await dockWidth()));
        check(
          'разделитель объявляет ширину',
          (await handle.getAttribute('aria-valuenow')) === '440',
        );

        await handle.focus();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await wait(200);
        check(
          'стрелка влево ×2 расширяет на 48 px',
          (await dockWidth()) === 488,
          String(await dockWidth()),
        );

        const box = await handle.boundingBox();
        const y = box.y + box.height / 2;
        const x = box.x + box.width / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 50, y, { steps: 5 });
        await page.mouse.move(x - 100, y, { steps: 5 });
        await page.mouse.up();
        await wait(200);
        const dragged = await dockWidth();
        check(
          'перетаскивание на 100 px влево — окно шире на 100',
          Math.abs(dragged - 588) <= 2,
          String(dragged),
        );
        const shifted = await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--panel-agent-dock-inset')
            .trim(),
        );
        check('страница сдвинута на ту же ширину', shifted === `${dragged}px`, shifted);
        await shot('dock-resized');

        await page.reload();
        await openAgent();
        await handle.waitFor({ timeout: 10_000 });
        check(
          'ширина пережила перезагрузку',
          Math.abs((await dockWidth()) - dragged) <= 2,
          String(await dockWidth()),
        );

        const far = await handle.boundingBox();
        await page.mouse.move(far.x + far.width / 2, far.y + far.height / 2);
        await page.mouse.down();
        await page.mouse.move(far.x - 2000, y, { steps: 10 });
        await page.mouse.up();
        await wait(200);
        check(
          'шире предела нельзя: 1400 − 480 = 920',
          (await dockWidth()) === 920,
          String(await dockWidth()),
        );
        // Запомнена та же ширина, что на экране, и разделитель объявляет предел:
        // иначе на широком мониторе окно раскрылось бы до «запомненных» 2000+.
        const stored = await page.evaluate(() =>
          localStorage.getItem('agentdeck:panel-agent-dock-width'),
        );
        check(
          'запомнено 920, предел объявлен 920',
          stored === '920' && (await handle.getAttribute('aria-valuemax')) === '920',
          `${stored} / ${await handle.getAttribute('aria-valuemax')}`,
        );
        await page.keyboard.press('ArrowRight');
        const near = await handle.boundingBox();
        await page.mouse.move(near.x + near.width / 2, near.y + near.height / 2);
        await page.mouse.down();
        await page.mouse.move(near.x + 2000, y, { steps: 10 });
        await page.mouse.up();
        await wait(200);
        check('уже 360 нельзя', (await dockWidth()) === 360, String(await dockWidth()));

        await page.setViewportSize({ width: 800, height: 900 });
        await wait(300);
        check('узкий экран: ручки нет', (await handle.count()) === 0);
        check(
          'узкий экран: окно прежней ширины 440',
          (await dockWidth()) === 440,
          String(await dockWidth()),
        );
        await page.setViewportSize({ width: 1400, height: 950 });
        await wait(300);
        check(
          'снова широкий: сохранённая ширина вернулась',
          (await dockWidth()) === 360,
          String(await dockWidth()),
        );
      }

      check(`тема ${scheme}: без ошибок страницы`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (needsModel) {
  const model = await startStubModel({ script: imagesScript, trace: TRACE });
  const stubEnv = { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };
  await runPanelAgentOnCore(
    {
      label: 'agent-images',
      model,
      settings: { theme: 'system' },
      env: stubEnv,
      seed: (paths) => {
        seedSkill(paths);
        // Вход claude для хода чата — адрес и ключ заглушки в личном слое (ядро передаёт его CLI).
        const settingsPath = join(paths.cfg, 'settings.json');
        const settings = existsSync(settingsPath)
          ? JSON.parse(readFileSync(settingsPath, 'utf8'))
          : {};
        writeFileSync(settingsPath, `${JSON.stringify({ ...settings, env: stubEnv }, null, 2)}\n`);
      },
    },
    scenario,
  );
} else {
  // Только ширина окна: ни ядро, ни модель не нужны.
  await runOnStand(
    { label: 'agent-images', settings: { theme: 'system' }, seed: seedSkill },
    scenario,
  );
}
