/**
 * Проверка проверки: золотой набор сообщений Telegram обязан краснеть.
 *
 * Золотая таблица (`telegram-html.test.ts`) сверяет каждое сообщение с точным
 * текстом. Зелёный прогон сам по себе ничего не доказывает: набор, который не
 * замечает поломку, был бы украшением. Поэтому здесь в ОДНОРАЗОВУЮ КОПИЮ
 * сервера по очереди подкладываются поломки разметки — нет экранирования, нет
 * маски, цитата при совпадении, предел без тегов, нет простого повтора,
 * варианты без номеров, нет строки итога, пропал «VS Code», вопрос обрезан без
 * «…полностью в панели», вопрос повторён, список без описаний, ссылка не
 * последней, нет проекта в первой строке, проект после сессии, D-n без имени
 * сессии — и поведения
 * бота: устаревшее нажатие ушло в чат, /start без кода окна принят, отвеченное
 * не свернулось, картинка из ответа потерялась, у вопроса сессии вне панели без
 * хука есть кнопки, такой вопрос отвечен продолжением чата панели. После каждой
 * наборы обязаны упасть.
 * Чистая копия обязана быть зелёной.
 *
 * Рабочее дерево не трогается: копия — во временном каталоге ОС, зависимости —
 * ссылками на те же `node_modules`.
 *
 * Запуск: node tools/qa/telegram-format-mustfail.mjs
 * Код выхода: 0 — каждая поломка поймана и чистая копия зелёная; 1 — нет.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
/**
 * Наборы: золотая таблица формата и поведение бота, которое владелец назвал
 * обязательным 25.10.2026 (устаревшее нажатие, код окна /start, сворачивание,
 * картинки в ответе).
 */
const SUITES = [
  'src/domains/notify/telegram-answers/telegram-html.test.ts',
  'src/domains/notify/telegram-answers/telegram-batch.test.ts',
  'src/domains/notify/telegram-answers/telegram-bot.test.ts',
  'src/domains/notify/telegram-answers/telegram-reply-media.test.ts',
  'src/domains/notify/telegram-answers/telegram-outside-question.test.ts',
];
const NOTIFY = 'src/domains/notify';

/** Поломка: файл, точный кусок кода и на что он меняется. */
const BREAKAGES = [
  {
    name: 'нет экранирования',
    file: `${NOTIFY}/telegram-answers/html.ts`,
    from: "return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
    to: 'return text;',
  },
  {
    name: 'маска секретов пропущена',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "const flat = (text: string): string => maskSecretsInText(text).replace(/\\s+/g, ' ').trim();",
    to: "const flat = (text: string): string => text.replace(/\\s+/g, ' ').trim();",
  },
  {
    name: 'цитата и при совпадении команды со второй строкой',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "const showCode = command !== '' && (command !== title || cut);",
    to: "const showCode = command !== '';",
  },
  {
    name: 'предел считается без тегов',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'if (full.length <= MESSAGE_LIMIT) return full;',
    to: 'if (htmlToPlain(full).length <= MESSAGE_LIMIT) return full;',
  },
  {
    name: "нет простого повтора на «can't parse entities»",
    file: `${NOTIFY}/telegram-answers/bot-api.ts`,
    from: 'if (first.ok || !isParseRefusal(first.status, first.description)) return first;',
    to: 'return first;',
  },
  {
    name: 'варианты вопроса без номеров',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'lines.push(`${at + 1}. ${label}${detail}`);',
    to: 'lines.push(`${label}${detail}`);',
  },
  {
    name: 'кнопки вариантов без номеров',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'const label = `${at + 1}. ${clip(option.label, LABEL_LIMIT)}`;',
    to: 'const label = clip(option.label, LABEL_LIMIT);',
  },
  {
    name: 'нет строки итога после нажатия',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'if (item.outcome) lines.push(escapeHtml(item.outcome));',
    to: '',
  },
  {
    name: 'пропал «VS Code» у сессии вне панели',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "if (source.app === 'outside') return 'VS Code';",
    to: '',
  },
  {
    name: 'вопрос обрезан без «…полностью в панели»',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "QUESTION_LIMIT, '…полностью в панели'),",
    to: "QUESTION_LIMIT, '…'),",
  },
  {
    name: 'нет проекта в первой строке',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "const folder = project.trim() ? `📁 ${project.trim()}` : '';",
    to: "const folder = '';",
  },
  {
    name: 'проект после сессии',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "[folder, via?.trim() ?? '', name]",
    to: "[via?.trim() ?? '', name, folder]",
  },
  {
    name: 'D-n без имени сессии',
    file: `${NOTIFY}/telegram-answers/collect.ts`,
    from: "return ask(chatId) || (parent ? ask(parent) : '');",
    to: "return '';",
  },
  {
    name: 'у вопроса сессии вне панели без хука есть кнопки',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "if (kind === 'outsideQuestion') return;",
    to: '',
  },
  {
    name: 'вопрос сессии вне панели отвечен продолжением чата (--resume)',
    file: `${NOTIFY}/telegram-answers/collect.ts`,
    from: "return Boolean(chat.runKey) || chat.client === 'panel';",
    to: 'return true;',
  },
  {
    name: 'у ошибки причина целиком вместо класса',
    file: `${NOTIFY}/telegram-text.ts`,
    from: "const errorClass = notice.kind === 'error' ? errorClassOf(notice.errorText) : undefined;",
    to: "const errorClass = notice.kind === 'error' ? notice.errorText : undefined;",
  },
  {
    name: 'вопрос повторён в первой строке',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'headLine(`${prefixOf(options)}❓ ВОПРОС${counter}`, placeOfCard(card)),',
    to: "headLine(`${prefixOf(options)}❓ ВОПРОС${counter}`, `${placeOfCard(card)} · ${safe(question?.question ?? '', 40)}`),",
  },
  {
    name: 'список вариантов и без описаний',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: 'if (question && options.index === undefined && described) {',
    to: 'if (question && options.index === undefined) {',
  },
  {
    name: 'ссылка не последней строкой',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "return url ? [...lines, '', linkLine(url)] : lines;",
    to: 'return url ? [linkLine(url), ...lines] : lines;',
  },
  {
    name: 'последний довод без экранирования',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: '  return escapeHtml(plain);',
    to: '  return plain;',
  },
  {
    name: 'устаревшее нажатие на вопрос ушло в чат',
    file: `${NOTIFY}/telegram-answers/service.ts`,
    from: "if (item.target.kind === 'question' && !(await this.stillOpen(item))) {",
    to: 'if (false) {',
  },
  {
    name: '/start без кода окна принят',
    file: `${NOTIFY}/telegram-answers/connect.ts`,
    from: "if (message.chat.type !== 'private' || !code || !this.code || !sameCode(code, this.code)) {",
    to: "if (message.chat.type !== 'private') {",
  },
  {
    name: 'отвеченное не сворачивается',
    file: `${NOTIFY}/telegram-answers/compose.ts`,
    from: "if (resolved) return clipHtmlSafe(message.items.map(collapsedLine).join('\\n'));",
    to: '',
  },
  {
    name: 'картинка из ответа потеряна',
    file: `${NOTIFY}/telegram-answers/replies.ts`,
    from: "files.push({ name: mediaName(at, files.length + 1, ref.ext), base64: body.toString('base64') });",
    to: '',
  },
];

/** Одноразовая копия сервера: исходники копией, зависимости и контракты — ссылками. */
function makeCopy() {
  const root = mkdtempSync(join(tmpdir(), 'tg-mustfail-'));
  const server = join(root, 'apps', 'server');
  mkdirSync(server, { recursive: true });
  // Всё корневое сервера, кроме зависимостей и тяжёлых ресурсов: конфиг vitest
  // тянет свой globalSetup рядом с собой.
  for (const name of readdirSync(join(REPO, 'apps', 'server'))) {
    if (name === 'node_modules' || name === 'assets') continue;
    cpSync(join(REPO, 'apps', 'server', name), join(server, name), { recursive: true });
  }
  symlinkSync(join(REPO, 'apps', 'server', 'assets'), join(server, 'assets'));
  // Ссылки как есть: `@agentdeck/contracts` смотрит на `../../../../packages/contracts`.
  cpSync(join(REPO, 'apps', 'server', 'node_modules'), join(server, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  // Конфиг TypeScript сервера наследует корневой.
  cpSync(join(REPO, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  symlinkSync(join(REPO, 'packages', 'contracts'), join(root, 'packages', 'contracts'));
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  return { root, server };
}

/** Прогон набора в копии: имена упавших тестов (пусто — зелёный). */
function runSuite(server) {
  const report = join(server, 'mustfail-report.json');
  rmSync(report, { force: true });
  const run = spawnSync(
    process.execPath,
    [
      join(REPO, 'apps', 'server', 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      ...SUITES,
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    { cwd: server, encoding: 'utf8', env: { ...process.env, WEB_PORT: '8888' } },
  );
  if (!existsSync(report)) {
    return {
      ok: false,
      failed: [`набор не запустился: ${(run.stderr || run.stdout).slice(-400)}`],
    };
  }
  const json = JSON.parse(readFileSync(report, 'utf8'));
  const failed = json.testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status !== 'passed')
      .map((test) => test.fullName ?? test.title),
  );
  // Ни одного теста — не «зелёный»: набор не нашёлся или не собрался.
  if (json.numTotalTests === 0) {
    return { ok: false, failed: ['ни одного теста не прошло сборку'], total: 0 };
  }
  return { ok: failed.length === 0, failed, total: json.numTotalTests };
}

const { root, server } = makeCopy();
let bad = 0;
try {
  const clean = runSuite(server);
  console.log(
    clean.ok
      ? `чистая копия: зелёная (${clean.total} тестов)`
      : `чистая копия: КРАСНАЯ — ${clean.failed.join('; ')}`,
  );
  if (!clean.ok) bad += 1;

  console.log('\nполомка → какой тест покраснел');
  for (const breakage of BREAKAGES) {
    const file = join(server, breakage.file);
    const original = readFileSync(file, 'utf8');
    const hits = original.split(breakage.from).length - 1;
    if (hits !== 1) {
      console.log(`  ✗ ${breakage.name}: кусок кода найден ${hits} раз — поломка не подложена`);
      bad += 1;
      continue;
    }
    writeFileSync(file, original.replace(breakage.from, breakage.to));
    try {
      const result = runSuite(server);
      if (result.failed.length === 0) {
        console.log(`  ✗ ${breakage.name}: набор ЗЕЛЁНЫЙ — поломка не поймана`);
        bad += 1;
      } else {
        console.log(
          `  ✓ ${breakage.name} → ${result.failed[0]}${result.failed.length > 1 ? ` (+${result.failed.length - 1})` : ''}`,
        );
      }
    } finally {
      writeFileSync(file, original);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(bad === 0 ? '\nКаждая поломка поймана.' : `\nНе сходится: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
