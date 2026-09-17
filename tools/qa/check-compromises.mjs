#!/usr/bin/env node
/**
 * Сверка подписей компромиссов: реестр ↔ код ↔ интерфейс ↔ словарь.
 *
 * Обход, о котором забыли сказать вслух, — это немой костыль: через месяц никто
 * не объяснит, почему поток разбирается руками, а бюджет вводится с
 * клавиатуры. Поэтому подпись живёт сразу в четырёх местах, и проверка держит
 * их вместе.
 *
 * Падает на четырёх случаях:
 *   1. в коде есть `// compromise: <id>`, а в реестре такого нет;
 *   2. реестр называет файлы-якоря, а комментария в них нет (или файла нет);
 *   3. подпись заведена, обход уже в коде, но на экране её нечем показать —
 *      нет ни одного `<CompromiseMark id="<id>" />` и не проставлен `uiHidden`;
 *   4. пустое «когда пересмотреть» или недостающий текст в ru/en.
 *
 * Пустой `codeAnchors` читается как «подписано заранее, кода ещё нет»: реестр
 * заполняется до начала работ, и требовать якорь с первого дня значило бы
 * рушить сборку на пустом месте. С того момента, как задача впишет в реестр
 * первый путь, с неё спрашивают и комментарий, и значок.
 *
 * Запуск: `node tools/qa/check-compromises.mjs` (сеть и стенд не нужны).
 * Свой слом: `node tools/qa/check-compromises.mjs --selftest` — прогоняет те же
 * правила на подложенных данных и проверяет, что каждый из четырёх случаев
 * действительно роняет проверку.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Телефон здесь же: у него свой toolchain, но подпись, невидимая проверке,
// однажды уедет туда — и молчаливо исчезнет.
const SCAN_DIRS = [
  'apps/web/src',
  'apps/server/src',
  'apps/mobile/app',
  'packages/contracts/src',
  'tools',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'android', 'ios', '.expo']);
const CODE_EXT = ['.ts', '.tsx', '.mjs', '.js'];
/** Файлы, где идентификаторы встречаются по долгу службы, а не как подпись. */
const NOT_ANCHORS = [
  join('packages', 'contracts', 'src', 'compromises.ts'),
  join('apps', 'server', 'src', 'domains', 'platform', 'compromises.ts'),
  join('tools', 'qa', 'check-compromises.mjs'),
];

const ANCHOR_RE = /\/\/\s*compromise:\s*([a-z0-9-]+)\s*—\s*\S/g;
/** Комментарий без причины после тире — тоже нарушение, ловим отдельно. */
const ANCHOR_LOOSE_RE = /\/\/\s*compromise:\s*([a-z0-9-]+)/g;
const MARK_RE = /<CompromiseMark[^>]*\bid=(?:"([a-z0-9-]+)"|\{'([a-z0-9-]+)'\})/g;

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (CODE_EXT.some((ext) => name.endsWith(ext))) files.push(full);
  }
  return files;
}

/** Все файлы кода, кроме тех, где идентификаторы стоят не как подпись. */
function sourceFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full, files);
  }
  return files.filter((file) => !NOT_ANCHORS.some((skip) => file.endsWith(skip)));
}

/**
 * Правила сверки — чистая функция над снимком: реестр, найденные в коде якоря,
 * значки на экране и словари. Так их можно прогнать на подложенных данных, а
 * не только на живом дереве.
 */
export function checkCompromises({
  registry,
  anchors,
  looseAnchors,
  marks,
  served = [],
  missingFiles = [],
  ru,
  en,
}) {
  const problems = [];
  const known = new Set(registry.map((entry) => entry.id));

  for (const { id, file } of looseAnchors) {
    if (!known.has(id)) {
      problems.push(`код: подпись «${id}» (${file}) не заведена в реестре компромиссов`);
      continue;
    }
    if (!anchors.some((anchor) => anchor.id === id && anchor.file === file)) {
      problems.push(`код: у подписи «${id}» (${file}) нет причины после тире`);
    }
  }

  for (const entry of registry) {
    const inCode = anchors.filter((anchor) => anchor.id === entry.id);
    const planned = entry.codeAnchors.length === 0;

    if (planned && inCode.length > 0) {
      problems.push(
        `реестр отстал: «${entry.id}» уже стоит в коде (${inCode[0].file}), а codeAnchors пуст`,
      );
    }

    for (const declared of entry.codeAnchors) {
      // Пропавший файл и файл без комментария — разные поломки: первая обычно
      // переезд, вторая забытая подпись, и лечатся они по-разному.
      if (missingFiles.includes(declared)) {
        problems.push(`реестр: «${entry.id}» ссылается на ${declared}, а такого файла нет`);
        continue;
      }
      const hit = inCode.some((anchor) => anchor.file === declared);
      if (!hit) problems.push(`реестр: «${entry.id}» обещает подпись в ${declared}, её там нет`);
    }

    // «Показать нечем» — это ни значка в разметке, ни идентификатора в списке,
    // которым сервер помечает свои ответы. Значок, собранный из данных
    // (`id={item.id}`), сам по себе не считается: строкой его не найти, и
    // засчитывать его вслепую значило бы засчитывать любую разметку.
    const onScreen = marks.includes(entry.id) || served.includes(entry.id);
    if (!planned && !entry.uiHidden && !onScreen) {
      problems.push(
        `интерфейс: «${entry.id}» нечем показать — нет ни CompromiseMark, ни строки в ответе сервера, ` +
          'и не проставлен uiHidden',
      );
    }

    for (const [lang, dict] of [
      ['ru', ru],
      ['en', en],
    ]) {
      const texts = dict?.compromise?.items?.[entry.id];
      if (!texts) {
        problems.push(`словарь ${lang}: у «${entry.id}» нет текстов`);
        continue;
      }
      for (const field of ['name', 'how', 'why', 'revisitWhen']) {
        if (!texts[field] || !String(texts[field]).trim()) {
          problems.push(`словарь ${lang}: у «${entry.id}» пусто поле ${field}`);
        }
      }
      if (entry.uiHidden && !String(texts.hiddenReason ?? '').trim()) {
        problems.push(`словарь ${lang}: «${entry.id}» помечен uiHidden, но причина не написана`);
      }
    }
  }

  // Обратная сторона той же сверки: снятая подпись не должна оставлять за собой
  // живой текст. Иначе человек читает объяснение обхода, которого больше нет.
  for (const [lang, dict] of [
    ['ru', ru],
    ['en', en],
  ]) {
    for (const id of Object.keys(dict?.compromise?.items ?? {})) {
      if (!known.has(id)) {
        problems.push(`словарь ${lang}: текст «${id}» есть, а подписи в реестре нет`);
      }
    }
  }

  return problems;
}

/**
 * Страница запроса к команде платформы (Т13) и её связь с реестром.
 *
 * Каждая просьба на той странице снимает конкретную подпись, и в «когда
 * пересмотреть» этой подписи стоит та же формулировка. Связь держится
 * проверкой, а не обещанием: без неё страницу правят, подпись остаётся с
 * прежним текстом — и человек читает в панели одно, а команда платформы
 * получила другое. `expects` — обрывок формулировки, который обязан найтись в
 * русском `revisitWhen`; `compromise: null` — строка, которая не снимает
 * ничего (так на странице и написано, прочерком).
 */
const REQUEST_DOC = 'docs/PLATFORM-ЗАПРОС.ru.md';

const REQUEST_ROWS = [
  {
    n: 1,
    compromise: 'no-client-tools',
    expects: 'схемы инструментов клиента',
    says: 'single_turn',
    cost: 'средняя',
  },
  {
    n: 2,
    compromise: 'nonstream-120s',
    expects: 'потолок ответа',
    says: 'WriteTimeout',
    cost: 'малая',
  },
  {
    n: 3,
    compromise: 'budget-manual',
    expects: 'остаток бюджета ключа',
    says: '/v1/keys/self',
    cost: 'малая',
  },
  {
    n: 4,
    compromise: 'budget-manual',
    expects: 'различать причины 401',
    says: 'invalid API key',
    cost: 'малая',
  },
  {
    n: 5,
    compromise: 'pricing-local',
    expects: 'цены моделей по ключу',
    says: 'supported_presets',
    cost: 'малая',
  },
  { n: 6, compromise: null, says: 'проверки содержимого не выполнялись', cost: 'малая' },
  {
    n: 7,
    compromise: 'context-managed',
    expects: 'изменении истории',
    says: 'summarizing',
    cost: 'малая',
  },
  {
    n: 8,
    compromise: 'kb-via-owner',
    expects: 'поиск по базам знаний',
    says: '/v1/search',
    cost: 'средняя',
  },
  { n: 9, compromise: null, says: '/v1/guardrails/scan', cost: 'средняя' },
  { n: 10, compromise: null, says: 'MCP-серверов', cost: 'малая' },
  {
    n: 11,
    compromise: 'agents-manual-roster',
    expects: 'перечисления агентов по ключу',
    says: 'перечисления агентов по ключу',
    cost: 'малая',
  },
  {
    n: 12,
    compromise: 'telemetry-local',
    expects: 'телеметрии от внешнего клиента',
    says: 'телеметрии от внешнего клиента',
    cost: 'средняя',
  },
  {
    n: 13,
    compromise: 'gateway-required',
    expects: 'короткоживущий токен',
    says: 'Короткоживущий токен',
    cost: 'средняя',
  },
  {
    n: 14,
    compromise: 'dialect-bridge',
    expects: 'диалекте Anthropic',
    says: '/v1/messages',
    cost: 'велика',
  },
  {
    n: 15,
    compromise: 'shim-no-cache',
    expects: 'кэш промпта',
    says: 'cache_control',
    cost: 'средняя',
  },
  {
    n: 16,
    compromise: 'no-effort',
    expects: 'поле глубины',
    says: 'reasoning_effort',
    cost: 'малая',
  },
  {
    n: 17,
    compromise: 'mask-unrestorable',
    expects: 'между маркерами инструмента',
    says: 'между маркерами инструмента',
    cost: 'средняя',
  },
];

/**
 * Вопросы пришпилены так же, как просьбы: номер плюс обрывок собственной
 * формулировки. Без этого таблицу вопросов можно было переписать или выбросить
 * из неё строку, и проверка осталась бы зелёной — она умела считать только, что
 * вопросов «сколько-то» и что правая колонка не пуста.
 */
const QUESTION_ROWS = [
  { n: 1, says: 'Кэш проверки ключа' },
  { n: 2, says: 'spend' },
  { n: 3, says: 'Оборванный поток' },
  { n: 4, says: 'X-RateLimit' },
  { n: 5, says: 'расходует слот RPM' },
  { n: 6, says: 'platform_deanonymized' },
  { n: 7, says: 'choices' },
  { n: 8, says: '451' },
  { n: 9, says: 'инструменты платформы включены' },
  { n: 10, says: 'совместимости публичного' },
  { n: 11, says: 'proxy-body-size' },
  { n: 12, says: 'для автотестов' },
  { n: 13, says: 'Окна перезапуска' },
  { n: 14, says: 'X-Platform-Source' },
  { n: 15, says: 'image_generation' },
];

/**
 * Осанка письма. Строки-обещания читает команда чужой платформы, и подмена
 * «просим» на «требуем» меняет не стиль, а отношения: страница перестаёт быть
 * тем, чем объявлена. Держим их дословно — как и любой другой факт здесь.
 */
const REQUEST_STANCE = [
  'Ничего из написанного ниже не блокирует нашу работу',
  'просьбы, а не требования',
];

/**
 * Где в письме живёт подпись, не привязанная к просьбе. Карта обязательна:
 * иначе очередная новая подпись молча не доезжает до команды платформы, а
 * письмо продолжает утверждать, что связано с реестром. `question` — номер
 * вопроса, который её закрывает; `outside` — причина, по которой ей в письме
 * места нет вовсе.
 */
const SIGNATURE_PLACES = {
  'vendor-sse-frames': { question: 7 },
  'status-451-bridge': { question: 8 },
  'key-cache-lag': { question: 1 },
  'probe-guess': { question: 10 },
  'cli-no-endpoint': {
    outside: 'у CLI нет настройки адреса — свойство чужого клиента, платформа тут ни при чём',
  },
  // Прослойка — НАШ обход чужого ограничения, а не просьба к платформе: своей
  // строки в письме у неё быть не может, и снимается она просьбой 1 вместе с
  // подписью, ради которой написана.
  'tool-shim': {
    outside:
      'наш обход ограничения `no-client-tools`: снимается просьбой 1, своей просьбы не имеет',
  },
  // Грубость здесь не платформы, а самого Claude Code: источник настроек `user`
  // у него один на правила, хуки, права, личные скиллы и личные MCP. Просить об
  // этом чужую команду бессмысленно — снимет подпись новый флаг CLI, не ответ на
  // письмо.
  'rules-partial': {
    outside:
      'зернистость флагов Claude Code, не контура: просить чужую платформу не о чем — снимет подпись флаг CLI',
  },
  // Доступность режима картинки держится на том, что контур объявил флаг
  // рисования, а объявлен ли он контрактом — как раз вопрос 15. Ответ «да, и вот
  // ручка изображений» снимает подпись; своей просьбы у неё нет, потому что
  // публиковать платформе нечего, кроме этого ответа.
  'media-by-capability': { question: 15 },
  // Подпись агента панели, не контура: чужой платформе здесь просить не о чем —
  // граница проходит между процессами одной машины.
  'agent-header-forgeable': {
    outside:
      'граница доверия между локальными процессами одного пользователя, контур тут ни при чём',
  },
};

/** Текст раздела `## <title>` до следующего заголовка того же уровня. */
function section(doc, title) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(title));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Строки таблицы, у которых первая ячейка — номер (шапка и разделитель отпадают сами). */
function tableRows(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (/^\d+$/.test(cells[0])) rows.push({ n: Number(cells[0]), cells });
  }
  return rows;
}

/**
 * Сверка страницы запроса с реестром. Отдельной функцией — по той же причине,
 * что и правила выше: снимок можно подложить и проверить, что каждое правило
 * действительно роняет прогон.
 */
export function checkRequestPage({
  doc,
  registry,
  ru,
  rows = REQUEST_ROWS,
  questionRows = QUESTION_ROWS,
  stance = REQUEST_STANCE,
  places = SIGNATURE_PLACES,
}) {
  const problems = [];
  if (typeof doc !== 'string' || doc.trim() === '') {
    problems.push(`страница запроса: ${REQUEST_DOC} не найдена или пуста`);
    return problems;
  }

  const asked = tableRows(section(doc, 'Что мы просим опубликовать'));
  const questions = tableRows(section(doc, 'Что непонятно'));
  const known = new Set(registry.map((entry) => entry.id));

  // Абзацы письма переносит prettier, и фраза живёт через перенос строки —
  // сверяем по тексту без них: перенос меняет вёрстку, а не сказанное.
  const flat = doc.replace(/\s+/g, ' ');
  for (const line of stance) {
    if (!flat.includes(line)) {
      problems.push(`страница запроса: пропала строка осанки — «${line}»`);
    }
  }

  const onPage = asked.map((row) => row.n).join(',');
  const inCheck = rows.map((row) => row.n).join(',');
  if (onPage !== inCheck) {
    problems.push(`страница запроса: строк на странице [${onPage}], а проверка знает [${inCheck}]`);
  }

  for (const expected of rows) {
    const row = asked.find((candidate) => candidate.n === expected.n);
    if (!row) continue;

    // Текст самой просьбы и цена вопроса — не оформление: подменённая
    // формулировка и сплющенные в одно слово цены уезжают чужой команде как
    // наше обещание. Сверка по номеру и подписи их не видела вовсе, поэтому
    // две просьбы можно было поменять местами телами при целых подписях.
    const ask = row.cells[1] ?? '';
    if (expected.says && !ask.includes(expected.says)) {
      problems.push(
        `страница запроса: просьба ${expected.n} переписана — в ней нет слов «${expected.says}»`,
      );
    }
    const cost = row.cells.at(-1) ?? '';
    if (expected.cost && !cost.startsWith(expected.cost)) {
      problems.push(
        `страница запроса: у просьбы ${expected.n} цена «${cost.split(':')[0].trim() || '—'}», ` +
          `а проверка ждёт «${expected.cost}»`,
      );
    }
    // Третья колонка — «Подпись»: либо идентификатор в обратных кавычках, либо
    // прочерк. Пустая ячейка читается как «забыли», а не как «ничего не снимает».
    const cell = row.cells[2] ?? '';
    const id = cell.replace(/`/g, '').trim();
    const declared = id === '—' ? null : id;

    if (declared !== expected.compromise) {
      problems.push(
        `страница запроса: в строке ${expected.n} подпись «${declared ?? '—'}», ` +
          `а проверка ждёт «${expected.compromise ?? '—'}»`,
      );
      continue;
    }
    if (declared === null) continue;
    if (!known.has(declared)) {
      problems.push(
        `страница запроса: строка ${expected.n} называет «${declared}» — его нет в реестре`,
      );
      continue;
    }

    const revisit = String(ru?.compromise?.items?.[declared]?.revisitWhen ?? '');
    if (!revisit.includes(expected.expects)) {
      problems.push(
        `страница запроса: просьба ${expected.n} не повторена в «когда пересмотреть» подписи ` +
          `«${declared}» — там нет слов «${expected.expects}»`,
      );
    }
  }

  // Вопрос без колонки «что делаем без ответа» — это уже не вопрос, а ожидание:
  // ровно то, чем страница обещает не быть. Прочерк здесь ничем не лучше
  // пустоты: он читается как ответ, не будучи им.
  if (questions.length === 0) problems.push('страница запроса: таблица вопросов пуста');
  const questionsOnPage = questions.map((row) => row.n).join(',');
  const questionsInCheck = questionRows.map((row) => row.n).join(',');
  if (questionsOnPage !== questionsInCheck) {
    problems.push(
      `страница запроса: вопросов на странице [${questionsOnPage}], ` +
        `а проверка знает [${questionsInCheck}]`,
    );
  }
  for (const expected of questionRows) {
    const row = questions.find((candidate) => candidate.n === expected.n);
    if (!row) continue;
    if (expected.says && !(row.cells[1] ?? '').includes(expected.says)) {
      problems.push(
        `страница запроса: вопрос ${expected.n} переписан — в нём нет слов «${expected.says}»`,
      );
    }
  }
  for (const row of questions) {
    const answer = String(row.cells.at(-1) ?? '').trim();
    if (!answer) {
      problems.push(`страница запроса: у вопроса ${row.n} пусто «что делаем без ответа»`);
    } else if (/^[—–-]+$/.test(answer)) {
      problems.push(
        `страница запроса: у вопроса ${row.n} вместо «что делаем без ответа» прочерк — ` +
          `это и есть превращённое в ожидание молчание`,
      );
    }
  }

  // Последнее правило — про полноту, а не про отдельную строку: реестр растёт
  // задачами партии, и без этой сверки очередная подпись просто не доезжает до
  // чужой команды, пока письмо продолжает утверждать, что связано с реестром.
  const bound = new Set(rows.map((row) => row.compromise).filter(Boolean));
  const questionNumbers = new Set(questions.map((row) => row.n));
  for (const entry of registry) {
    if (bound.has(entry.id)) continue;
    const place = places[entry.id];
    if (!place) {
      problems.push(
        `страница запроса: подпись «${entry.id}» нигде в письме не названа — ` +
          `ни просьбой, ни вопросом, и не объявлена лежащей вне его`,
      );
      continue;
    }
    if (place.question !== undefined && !questionNumbers.has(place.question)) {
      problems.push(
        `страница запроса: подпись «${entry.id}» закрывается вопросом ${place.question}, ` +
          `а такого вопроса на странице нет`,
      );
    }
    if (place.outside !== undefined && !String(place.outside).trim()) {
      problems.push(`страница запроса: подпись «${entry.id}» объявлена вне письма без причины`);
    }
  }

  return problems;
}

/** Реестр и словари — обычным импортом: на этом Node типы снимаются на лету. */
async function loadModules() {
  const registry = await import(
    new URL('../../packages/contracts/src/compromises.ts', import.meta.url).href
  );
  const ruDict = await import(
    new URL('../../apps/web/src/shared/config/i18n/ru.ts', import.meta.url).href
  );
  const enDict = await import(
    new URL('../../apps/web/src/shared/config/i18n/en.ts', import.meta.url).href
  );
  return { registry: registry.COMPROMISES, ru: ruDict.ru, en: enDict.en };
}

function collect(registry) {
  const anchors = [];
  const looseAnchors = [];
  const marks = [];
  const served = [];
  const declared = new Set(registry.flatMap((entry) => entry.codeAnchors));
  const seenFiles = new Set();

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const short = relative(ROOT, file).split(sep).join('/');
    seenFiles.add(short);
    for (const match of text.matchAll(ANCHOR_RE)) anchors.push({ id: match[1], file: short });
    for (const match of text.matchAll(ANCHOR_LOOSE_RE))
      looseAnchors.push({ id: match[1], file: short });

    // Витрина — не панель: значок в story объясняет компонент, а не подписывает
    // живое место, и засчитывать её значило бы закрывать правило самим собой.
    if (!short.endsWith('.stories.tsx')) {
      for (const match of text.matchAll(MARK_RE)) marks.push(match[1] ?? match[2]);
    }

    // Что подписано, решает сервер: идентификатор, названный в его коде,
    // приезжает на экран данными — значком, собранным в цикле.
    if (short.startsWith('apps/server/src/') && !short.includes('.test.')) {
      for (const entry of registry) {
        if (text.includes(`'${entry.id}'`) || text.includes(`"${entry.id}"`)) served.push(entry.id);
      }
    }
  }

  const missingFiles = [...declared].filter((path) => !seenFiles.has(path));
  return { anchors, looseAnchors, marks, served, missingFiles };
}

/**
 * Подложенный слом: каждый из четырёх случаев проверяется на снимке, который
 * заведомо неправилен. Проверка, которая сама никогда не падала, ничего не
 * гарантирует.
 */
function selftest() {
  const base = {
    registry: [
      { id: 'signed-one', severity: 'workaround', since: '2026-09-09', codeAnchors: ['a/b.ts'] },
    ],
    anchors: [{ id: 'signed-one', file: 'a/b.ts' }],
    looseAnchors: [{ id: 'signed-one', file: 'a/b.ts' }],
    marks: ['signed-one'],
    ru: { compromise: { items: { 'signed-one': texts() } } },
    en: { compromise: { items: { 'signed-one': texts() } } },
  };

  // У каждого случая свой ожидаемый текст: снимок, сломанный сразу в двух
  // местах, «ловится» соседним правилом, и проверка выглядит рабочей, будучи
  // дырявой. Поэтому сверяем не факт падения, а какое именно правило сработало.
  const cases = [
    [
      'подпись в коде вне реестра',
      { ...base, looseAnchors: [{ id: 'ghost', file: 'a/b.ts' }] },
      'не заведена в реестре',
    ],
    [
      'реестр обещает якорь, которого нет',
      { ...base, anchors: [], looseAnchors: [] },
      'обещает подпись в a/b.ts',
    ],
    ['нет ни значка, ни uiHidden', { ...base, marks: [] }, 'нечем показать'],
    [
      'пустое «когда пересмотреть»',
      { ...base, en: { compromise: { items: { 'signed-one': texts({ revisitWhen: '' }) } } } },
      'пусто поле revisitWhen',
    ],
    ['подпись без причины после тире', { ...base, anchors: [] }, 'нет причины после тире'],
    [
      'реестр отстал от кода',
      {
        ...base,
        registry: [{ ...base.registry[0], codeAnchors: [] }],
      },
      'реестр отстал',
    ],
    [
      'файл-якорь переехал',
      { ...base, anchors: [], looseAnchors: [], missingFiles: ['a/b.ts'] },
      'такого файла нет',
    ],
    [
      'текст остался от снятой подписи',
      {
        ...base,
        ru: { compromise: { items: { 'signed-one': texts(), 'lifted-one': texts() } } },
      },
      'а подписи в реестре нет',
    ],
  ];

  // Здоровыми считаются оба способа показать подпись: значок в разметке и
  // идентификатор, названный сервером. Второй — единственный, которым можно
  // подписать элемент, собранный из данных.
  const healthy = [
    ['значок в разметке', base],
    ['подпись едет данными от сервера', { ...base, marks: [], served: ['signed-one'] }],
  ];

  let failed = 0;
  for (const [name, snapshot] of healthy) {
    const problems = checkCompromises(snapshot);
    if (problems.length > 0) {
      failed += 1;
      console.error(`  ✗ здоровый снимок объявлен сломанным (${name}): ${problems.join('; ')}`);
    } else {
      console.log(`  ✓ здоровый снимок проходит: ${name}`);
    }
  }

  for (const [name, snapshot, expected] of cases) {
    const problems = checkCompromises(snapshot);
    const hit = problems.find((problem) => problem.includes(expected));
    if (!hit) {
      failed += 1;
      console.error(
        `  ✗ не поймано: ${name} — ждали «${expected}», получили: ${problems.join('; ') || '—'}`,
      );
    } else {
      console.log(`  ✓ поймано: ${name} — ${hit}`);
    }
  }
  return failed + requestSelftest();
}

/**
 * Свой слом сверки со страницей запроса. Снимок — крошечная страница из двух
 * таблиц: так правила проверяются на разборе настоящего markdown, а не на
 * заранее разобранных строках, где сам разбор и остался бы непроверенным.
 */
function requestSelftest() {
  const page = (rows, questions, stance = 'Список ниже — просьбы, а не требования.') =>
    [
      stance,
      '',
      '## Что мы просим опубликовать',
      '',
      '| #   | Что просим | Подпись | Что это даст нам | Цена |',
      '| --- | ---------- | ------- | ---------------- | ---- |',
      ...rows,
      '',
      '## Что непонятно — вопросы',
      '',
      '| #   | Вопрос | Почему важно | Что делаем без ответа |',
      '| --- | ------ | ------------ | --------------------- |',
      ...questions,
      '',
    ].join('\n');

  const ASKS = [
    '| 1   | просим одно | `signed-one` | польза | малая: одно значение |',
    '| 2   | просим два | — | польза | средняя: нужен маршрут |',
  ];
  const QUESTIONS = ['| 1   | вопрос про кадры | важно | обходимся |'];

  const entry = (id) => ({ id, severity: 'workaround', since: '2026-09-09', codeAnchors: [] });

  const base = {
    doc: page(ASKS, QUESTIONS),
    registry: [entry('signed-one'), entry('asked-elsewhere'), entry('not-our-business')],
    ru: {
      compromise: { items: { 'signed-one': texts({ revisitWhen: 'Если контур отдаст цены.' }) } },
    },
    rows: [
      {
        n: 1,
        compromise: 'signed-one',
        expects: 'отдаст цены',
        says: 'просим одно',
        cost: 'малая',
      },
      { n: 2, compromise: null, says: 'просим два', cost: 'средняя' },
    ],
    questionRows: [{ n: 1, says: 'вопрос про кадры' }],
    stance: ['просьбы, а не требования'],
    places: {
      'asked-elsewhere': { question: 1 },
      'not-our-business': { outside: 'свойство чужого клиента' },
    },
  };

  const cases = [
    [
      'строку со страницы убрали',
      { ...base, doc: page([ASKS[0]], QUESTIONS) },
      'строк на странице',
    ],
    [
      'подпись в строке разошлась с проверкой',
      {
        ...base,
        doc: page(
          [
            '| 1   | просим одно | — | польза | малая: одно значение |',
            '| 2   | просим два | — | польза | средняя: нужен маршрут |',
          ],
          QUESTIONS,
        ),
      },
      'а проверка ждёт «signed-one»',
    ],
    [
      'страница называет подпись вне реестра',
      { ...base, registry: [entry('asked-elsewhere'), entry('not-our-business')] },
      'нет в реестре',
    ],
    [
      'формулировка не доехала до «когда пересмотреть»',
      {
        ...base,
        ru: { compromise: { items: { 'signed-one': texts({ revisitWhen: 'Когда-нибудь.' }) } } },
      },
      'не повторена в «когда пересмотреть»',
    ],
    [
      'вопрос без «что делаем без ответа»',
      { ...base, doc: page(ASKS, ['| 1   | вопрос про кадры | важно |  |']) },
      'пусто «что делаем без ответа»',
    ],
    ['страницы нет вовсе', { ...base, doc: undefined }, 'не найдена или пуста'],

    // Ниже — шесть подделок, на которых прежняя сверка оставалась зелёной:
    // она знала только номера строк и подписи, а телу просьбы, цене, вопросам и
    // осанке письма верила на слово.
    [
      'тело просьбы переписали, подпись оставили',
      {
        ...base,
        doc: page(
          [
            '| 1   | просим совсем другое | `signed-one` | польза | малая: одно значение |',
            ASKS[1],
          ],
          QUESTIONS,
        ),
      },
      'просьба 1 переписана',
    ],
    [
      'две просьбы поменяли телами',
      {
        ...base,
        doc: page(
          [
            '| 1   | просим два | `signed-one` | польза | малая: одно значение |',
            '| 2   | просим одно | — | польза | средняя: нужен маршрут |',
          ],
          QUESTIONS,
        ),
      },
      'просьба 1 переписана',
    ],
    [
      'цены сплющили в одно слово',
      {
        ...base,
        doc: page([ASKS[0], '| 2   | просим два | — | польза | малая: нужен маршрут |'], QUESTIONS),
      },
      'а проверка ждёт «средняя»',
    ],
    ['вопрос выкинули целиком', { ...base, doc: page(ASKS, []) }, 'вопросов на странице'],
    [
      'вопрос переписали',
      { ...base, doc: page(ASKS, ['| 1   | вопрос про другое | важно | обходимся |']) },
      'вопрос 1 переписан',
    ],
    [
      'вместо «что делаем без ответа» прочерк',
      { ...base, doc: page(ASKS, ['| 1   | вопрос про кадры | важно | — |']) },
      'вместо «что делаем без ответа» прочерк',
    ],
    [
      'просьбы превратили в требования',
      {
        ...base,
        doc: page(ASKS, QUESTIONS, 'Список ниже — требования к платформе.'),
      },
      'строка осанки',
    ],
    [
      'новая подпись не доехала до письма',
      { ...base, registry: [...base.registry, entry('fresh-one')] },
      'нигде в письме не названа',
    ],
    [
      'подпись закрыта вопросом, которого нет',
      { ...base, places: { ...base.places, 'asked-elsewhere': { question: 9 } } },
      'такого вопроса на странице нет',
    ],
  ];

  let failed = 0;
  const healthy = checkRequestPage(base);
  if (healthy.length > 0) {
    failed += 1;
    console.error(`  ✗ здоровая страница объявлена сломанной: ${healthy.join('; ')}`);
  } else {
    console.log('  ✓ здоровый снимок проходит: страница запроса сходится с реестром');
  }

  for (const [name, snapshot, expected] of cases) {
    const problems = checkRequestPage(snapshot);
    const hit = problems.find((problem) => problem.includes(expected));
    if (!hit) {
      failed += 1;
      console.error(
        `  ✗ не поймано: ${name} — ждали «${expected}», получили: ${problems.join('; ') || '—'}`,
      );
    } else {
      console.log(`  ✓ поймано: ${name} — ${hit}`);
    }
  }
  return failed;
}

function texts(overrides = {}) {
  return {
    name: 'имя',
    how: 'как',
    why: 'почему',
    revisitWhen: 'когда',
    ...overrides,
  };
}

async function main() {
  if (process.argv.includes('--selftest')) {
    console.log('Свой слом проверки подписей:');
    const failed = selftest();
    if (failed > 0) {
      console.error(`\nПроверка пропускает поломок: ${failed} — доверять ей нельзя.`);
      process.exit(1);
    }
    console.log('\nКаждая поломка ловится своим правилом.');
    return;
  }

  const { registry, ru, en } = await loadModules();
  const { anchors, looseAnchors, marks, served, missingFiles } = collect(registry);
  const problems = checkCompromises({
    registry,
    anchors,
    looseAnchors,
    marks,
    served,
    missingFiles,
    ru,
    en,
  });

  const requestDoc = join(ROOT, REQUEST_DOC);
  problems.push(
    ...checkRequestPage({
      doc: existsSync(requestDoc) ? readFileSync(requestDoc, 'utf8') : undefined,
      registry,
      ru,
    }),
  );

  const planned = registry.filter((entry) => entry.codeAnchors.length === 0).map((e) => e.id);
  const lifting = new Set(REQUEST_ROWS.map((row) => row.compromise).filter(Boolean));
  console.log(
    `Подписей в реестре: ${registry.length} · значков на экране: ${new Set(marks).size} · ` +
      `в ответах сервера: ${new Set(served).size} · якорей в коде: ${anchors.length}`,
  );
  // Молчаливая проверка — то же, что её отсутствие: строкой видно, что страница
  // запроса вообще разобрана и сколько подписей на ней держится.
  console.log(
    `Страница запроса: просьб ${REQUEST_ROWS.length} · снимут подписей ${lifting.size} ` +
      `(${[...lifting].join(', ')})`,
  );
  // Числом «ещё не в коде: 14» отчитаться легко, и через месяц его перестают
  // читать. Именами — нет: видно, какая задача партии за какую подпись должна
  // ответить.
  if (planned.length > 0) console.log(`Ещё не в коде (${planned.length}): ${planned.join(', ')}`);

  if (problems.length > 0) {
    console.error('\nНарушения:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('Реестр, код, интерфейс и словари сходятся.');
}

// Типы снимаются самим Node с 22.18; на более старом 22.x нужен флаг, поэтому
// перезапускаем себя с ним, а не падаем с невнятным ERR_UNKNOWN_FILE_EXTENSION.
if (!process.features.typescript && !process.env.CC_COMPROMISES_RETRY) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, CC_COMPROMISES_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
