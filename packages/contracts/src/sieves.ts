/**
 * Сита перед MR — каталог, применимость, блок отчёта и судья отчёта.
 *
 * Зачем (решение владельца 28.09.2026): блокеры ревьюеров в MR групп
 * разделения повторяются классами — доки и контракт расходятся с кодом (18),
 * интеграция с основной веткой (6), изоляция стенда и фокуса (3), потребители
 * вне диффа (3), граничный ввод (1). Каждый класс получает сито ДО MR, и сито
 * взято из реального блокера, а не из чек-листа «на всякий случай».
 *
 * Сито здесь — не строка в задании, которую модель может пропустить молча.
 * Его держат три вещи:
 * 1. ПРИМЕНИМОСТЬ по фактам: какие сита касаются группы, панель решает по
 *    затронутым путям (`touchKinds`), а не по словам агента.
 * 2. ОТЧЁТ С ДОКАЗАТЕЛЬСТВОМ: звено отвечает блоком `sieves` — строка на каждое
 *    применимое сито, `pass`/`n/a` только с доказательством (команда и строка
 *    её вывода, или причина). Нет строки — сито не пройдено (`judgeSieves`).
 * 3. МЕХАНИКА ПАНЕЛИ: то, что проверяется git без модели (конфликт со свежей
 *    основной, удаление чужого кода, оставшиеся потребители удалённого),
 *    панель проверяет сама; такое срабатывание снимается только отчётом,
 *    который называет КАЖДЫЙ отмеченный файл, а конфликт — ничем, кроме rebase.
 *
 * Обучение: тред ревьюера, пересланный группе наблюдателем MR, группа
 * раскладывает в сито (`learned` в том же блоке). Панель принимает его, только
 * если оно ссылается на тред, который она сама переслала (`acceptLearned`), —
 * сито из выдуманного блокера не проходит.
 *
 * Модуль без zod и без импортов других сабпатов: его читают сервер, лента
 * панели и телефон (прячут блок из текста).
 *
 * ```agentdeck:sieves
 * {"sieves":[{"id":"browser-focus","status":"pass","evidence":"npx playwright test focus.spec.ts → 4 passed"}],
 *  "learned":[{"thread":"https://…#note_1","class":"contract","scope":"project","trigger":"…","check":"…"}]}
 * ```
 */

import { blockLang, blockLangPattern } from './brand.ts';

/** Язык блока отчёта о ситах. */
export const SIEVE_LANG = blockLang('sieves');

/** Классы блокеров — строки таблицы владельца; `other` — выученное вне них. */
export const SIEVE_CLASSES = [
  'contract',
  'integration',
  'isolation',
  'consumers',
  'boundary',
  'other',
] as const;
export type SieveClass = (typeof SIEVE_CLASSES)[number];

/** Что затронуто диффом группы — по путям. */
export type TouchKind = 'ui' | 'backend' | 'contract' | 'code';

/** Звено, в котором сито делается. Доставка — последний рубеж и судья всех. */
export type SieveStage = 'review' | 'deliver';

export const BUILTIN_SIEVE_IDS = [
  'contract-by-request',
  'consumers-repo-wide',
  'merge-tree',
  'foreign-removals',
  'browser-focus',
  'branch-backend-stand',
  'boundary-negative',
] as const;
export type BuiltinSieveId = (typeof BUILTIN_SIEVE_IDS)[number];

export interface SieveDef {
  id: BuiltinSieveId;
  class: SieveClass;
  /** Где сито делается впервые; доставка проверяет отчёт по всем. */
  stage: SieveStage;
  /** Применимо, если дифф задел хоть один из видов. Пусто — всегда. */
  when: readonly TouchKind[];
  /**
   * Панель проверяет сама (git). `merge-tree` и `foreign-removals` строки отчёта не
   * требуют — она нужна только, чтобы снять срабатывание, назвав каждый отмеченный
   * файл. `consumers-repo-wide` панель лишь перепроверяет: её поиск видит удалённые
   * имена, а не переименованный test-id, поэтому группа сдаёт свою строку, пока
   * панель ничего не отметила (`judgeSieves`).
   */
  mechanical?: true;
  /** Задание модели (английский, как все задания звеньев). */
  text: string;
}

export const BUILTIN_SIEVES: readonly SieveDef[] = [
  {
    id: 'contract-by-request',
    class: 'contract',
    stage: 'review',
    when: ['contract', 'backend'],
    text:
      'Second entry, from the contract, not from the diff: list every claim that docs, API ' +
      'contracts, OpenAPI/proto/schema files, README or help make about the changed behaviour ' +
      '(status codes, field names, error shapes, limits, defaults). Check EACH by a real request ' +
      'to a stand running THIS branch (curl, or the route integration test through the real ' +
      'route) and compare with the actual response. A claim checked only by reading code is not ' +
      'checked. Evidence: the request and the observed status/body line.',
  },
  {
    id: 'consumers-repo-wide',
    class: 'consumers',
    stage: 'review',
    when: ['code'],
    mechanical: true,
    text:
      'Consumers outside the diff: for every changed or removed string, role, test id, route, ' +
      'i18n key and exported name, search the WHOLE repository (git grep), including e2e, QA and ' +
      'autotest folders and other packages, and fix or name each consumer. Evidence: the search ' +
      'commands and what they found.',
  },
  {
    id: 'merge-tree',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    text:
      'Integration with fresh main: after `git fetch`, `git merge-tree --write-tree ' +
      'origin/<main> HEAD` must report no conflicts. The panel runs it itself; a conflict is ' +
      'cleared only by rebasing onto fresh main.',
  },
  {
    id: 'foreign-removals',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    text:
      'No foreign "−": the diff against main must not delete lines that landed in main after the ' +
      "group started (someone else's work lost in a rebase or an overwritten file). The panel " +
      'checks it itself; an intended removal is reported with EVERY such file named and why.',
  },
  {
    id: 'browser-focus',
    class: 'isolation',
    stage: 'deliver',
    when: ['ui'],
    text:
      'UI changed: run a browser test (Playwright or the project e2e) over the changed screens — ' +
      'Tab order, visible focus, Escape/Enter, and layout at a narrow and a wide width. A unit ' +
      'test of the component does not count. Evidence: the command and its pass line.',
  },
  {
    id: 'branch-backend-stand',
    class: 'isolation',
    stage: 'deliver',
    when: ['backend'],
    text:
      'Backend changed: live checks run against a stand whose backend is built from THIS branch, ' +
      'not from main or a shared dev stand. Evidence: which process/port and the commit it runs.',
  },
  {
    id: 'boundary-negative',
    class: 'boundary',
    stage: 'deliver',
    when: ['code'],
    text:
      'In the live run add one negative at a type or limit boundary of the changed input (empty, ' +
      'max+1, wrong type, missing field) and check the refusal is the documented one. Evidence: ' +
      'the input and the observed response.',
  },
];

const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const BACKEND_EXT = /\.(go|py|java|kt|kts|rb|php|rs|cs|ex|exs|scala|sql)$/i;
const BACKEND_DIR = /(^|\/)(server|backend|api|services?)\//i;
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s)$/i;
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const CONTRACT_NAME = /(^|\/)[^/]*(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const CONTRACT_EXT = /\.(proto|graphql|gql)$/i;
const CONTRACT_DIR = /(^|\/)(contracts?|docs?|api-docs)\//i;
const TEST_PATH =
  /(^|\/)(__tests__|tests?|e2e|qa|spec|cypress|playwright)\/|\.(test|spec|stories)\.[^/]+$/i;
/** Служебные каталоги агентов и инструментов — не доки продукта. */
const DOT_DIR = /(^|\/)\.[^/]+\//;

/** Виды затронутого по списку путей диффа (прямые слэши, от корня репозитория). */
export function touchKinds(paths: readonly string[]): Set<TouchKind> {
  const kinds = new Set<TouchKind>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/');
    if (DOT_DIR.test(path)) continue;
    const test = TEST_PATH.test(path);
    if (
      CONTRACT_NAME.test(path) ||
      CONTRACT_EXT.test(path) ||
      (DOC_EXT.test(path) && !test) ||
      (CONTRACT_DIR.test(path) && !test && (CODE_EXT.test(path) || /\.(ya?ml|json)$/i.test(path)))
    ) {
      kinds.add('contract');
    }
    if (test) continue;
    if (UI_EXT.test(path)) kinds.add('ui');
    if (BACKEND_EXT.test(path) || (BACKEND_DIR.test(path) && CODE_EXT.test(path))) {
      kinds.add('backend');
    }
    if (UI_EXT.test(path) || BACKEND_EXT.test(path) || CODE_EXT.test(path)) kinds.add('code');
  }
  return kinds;
}

/** Встроенные сита, применимые к диффу с этими путями. Пустой дифф — ни одного. */
export function applicableSieves(paths: readonly string[]): SieveDef[] {
  if (paths.length === 0) return [];
  const kinds = touchKinds(paths);
  return BUILTIN_SIEVES.filter(
    (sieve) => sieve.when.length === 0 || sieve.when.some((kind) => kinds.has(kind)),
  );
}

// ---------------------------------------------------------------- отчёт

export type SieveStatus = 'pass' | 'fail' | 'n/a';

export interface SieveReportRow {
  id: string;
  status: SieveStatus;
  evidence: string;
}

/** Строка выученного сита, как её пишет группа. */
export interface LearnedSieveRow {
  thread: string;
  class: SieveClass;
  scope: 'project' | 'global';
  trigger: string;
  check: string;
}

export interface SieveScan {
  text: string;
  rows: SieveReportRow[];
  learned: LearnedSieveRow[];
  rejected: number;
}

/** Потолки — отчёт уезжает в запись группы и в напоминания. */
const EVIDENCE_MAX = 600;
const ROWS_MAX = 30;
const LEARNED_MAX = 20;
export const LEARNED_TEXT_MIN = 20;
export const LEARNED_TEXT_MAX = 400;
/**
 * Короче этого — не доказательство, а «ok». Порог низкий намеренно: «n/a:
 * CSS не менялся» — законная причина, её отсекать нельзя.
 */
export const EVIDENCE_MIN = 12;

const STATUSES: readonly string[] = ['pass', 'fail', 'n/a'];

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isClass(value: unknown): value is SieveClass {
  return typeof value === 'string' && (SIEVE_CLASSES as readonly string[]).includes(value);
}

/** Тело блока → отчёт; не JSON или не объект — `undefined`, блок остаётся текстом. */
export function parseSieveBody(
  body: string,
): { rows: SieveReportRow[]; learned: LearnedSieveRow[] } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { sieves, learned } = value as { sieves?: unknown; learned?: unknown };
  if (sieves === undefined && learned === undefined) return undefined;

  const rows: SieveReportRow[] = [];
  for (const item of Array.isArray(sieves) ? sieves : []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = text(row.id, 80);
    const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    if (!id || !STATUSES.includes(status)) continue;
    rows.push({
      id,
      status: status as SieveStatus,
      evidence: text(row.evidence, EVIDENCE_MAX) ?? '',
    });
    if (rows.length >= ROWS_MAX) break;
  }

  const lessons: LearnedSieveRow[] = [];
  for (const item of Array.isArray(learned) ? learned : []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const thread = text(row.thread, 500);
    const trigger = text(row.trigger, LEARNED_TEXT_MAX);
    const check = text(row.check, LEARNED_TEXT_MAX);
    if (!thread || !trigger || !check) continue;
    lessons.push({
      thread,
      class: isClass(row.class) ? row.class : 'other',
      scope: row.scope === 'global' ? 'global' : 'project',
      trigger,
      check,
    });
    if (lessons.length >= LEARNED_MAX) break;
  }
  return { rows, learned: lessons };
}

const OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('sieves')}[ \\t]*\\r?\\n`);
const CLOSE = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/;

/**
 * Вынуть блоки отчёта из текста — те же три случая, что у блока эскалации:
 * разобранный уходит, сломанный остаётся как есть, незакрытый при `streaming`
 * прячется до конца. Несколько блоков в ответе складываются: последняя строка
 * сита побеждает.
 */
export function scanSieveBlocks(source: string, options: { streaming?: boolean } = {}): SieveScan {
  const byId = new Map<string, SieveReportRow>();
  const learned: LearnedSieveRow[] = [];
  let rejected = 0;
  let rest = source;
  let out = '';
  let found = false;

  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }
    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);
    const close = CLOSE.exec(rest.slice(bodyStart));
    if (!close) {
      if (!options.streaming) out += rest.slice(open.index + lead);
      break;
    }
    const parsed = parseSieveBody(rest.slice(bodyStart, bodyStart + close.index));
    if (parsed) {
      found = true;
      for (const row of parsed.rows) byId.set(row.id, row);
      learned.push(...parsed.learned);
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }
    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  if (!found && out === source) return { text: source, rows: [], learned: [], rejected };
  return {
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    rows: [...byId.values()],
    learned: learned.slice(0, LEARNED_MAX),
    rejected,
  };
}

/** Текст для показа человеку: без блоков отчёта. */
export function withoutSieveBlocks(source: string, options?: { streaming?: boolean }): string {
  return scanSieveBlocks(source, options).text;
}

/** Отчёт группы, накопленный по звеньям: новая строка сита заменяет прежнюю. */
export function mergeSieveRows(
  previous: readonly SieveReportRow[] | undefined,
  next: readonly SieveReportRow[],
): SieveReportRow[] {
  const byId = new Map((previous ?? []).map((row) => [row.id, row]));
  for (const row of next) byId.set(row.id, row);
  return [...byId.values()].slice(-ROWS_MAX);
}

// ---------------------------------------------------------------- судья

/** Что панель сама нашла git'ом (`sieve-facts.ts` сервера). */
export interface SieveMechanics {
  /** Файлы с конфликтом при слиянии со свежей основной. */
  conflicts?: string[];
  /** Файлы, где ветка удалила строки, пришедшие в основную после старта группы. */
  foreignRemovals?: string[];
  /** Удалённое имя/тест-id и файлы вне диффа, где оно ещё встречается. */
  consumers?: { token: string; files: string[] }[];
}

/** Пробел сита: код текста сервера и параметры — строку собирает сервер. */
export interface SieveGap {
  code:
    | 'sieve-gap-conflicts'
    | 'sieve-gap-foreign-removals'
    | 'sieve-gap-consumers'
    | 'sieve-gap-unreported'
    | 'sieve-gap-no-evidence'
    | 'sieve-gap-failed';
  params: Record<string, string>;
}

/**
 * Все ли пути названы в доказательстве — так снимается механическое срабатывание.
 * Имя файла без пути годится, только если оно среди отмеченных одно: иначе
 * «index.ts» снимал бы разом `apps/a/index.ts` и `apps/b/index.ts` (ревью сит).
 */
function namesAll(evidence: string, files: readonly string[]): boolean {
  const low = evidence.replace(/\\/g, '/').toLowerCase();
  const paths = files.map((file) => file.replace(/\\/g, '/').toLowerCase());
  const baseOf = (path: string): string => path.split('/').pop() ?? path;
  const bases = paths.map(baseOf);
  return paths.every((path) => {
    const base = baseOf(path);
    const unique = bases.filter((other) => other === base).length === 1;
    return low.includes(path) || (unique && low.includes(base));
  });
}

const NAMED_MAX = 5;
function named(files: readonly string[]): string {
  const head = files.slice(0, NAMED_MAX).join(', ');
  return files.length > NAMED_MAX ? `${head} (+${files.length - NAMED_MAX})` : head;
}

/**
 * Судья сит перед «доставлено». Пусто — все применимые сита пройдены.
 *
 * - конфликт со свежей основной не снимается ничем: только rebase;
 * - механическое срабатывание (чужие «−», потребители) снимается строкой
 *   отчёта этого сита со статусом `pass`/`n/a`, чьё доказательство называет
 *   КАЖДЫЙ отмеченный файл — «проверил, всё ок» без имён не проходит;
 * - немеханическое сито без строки — не пройдено; `pass`/`n/a` без
 *   доказательства — не пройдено; `fail` — не пройдено с доказательством.
 */
export function judgeSieves(input: {
  applicable: readonly SieveDef[];
  rows: readonly SieveReportRow[];
  mechanics: SieveMechanics;
}): SieveGap[] {
  const gaps: SieveGap[] = [];
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  const cleared = (id: BuiltinSieveId, files: readonly string[]): boolean => {
    const row = rows.get(id);
    return Boolean(
      row &&
      row.status !== 'fail' &&
      row.evidence.length >= EVIDENCE_MIN &&
      namesAll(row.evidence, files),
    );
  };

  const conflicts = input.mechanics.conflicts ?? [];
  if (conflicts.length > 0) {
    gaps.push({ code: 'sieve-gap-conflicts', params: { files: named(conflicts) } });
  }
  const foreign = input.mechanics.foreignRemovals ?? [];
  if (foreign.length > 0 && !cleared('foreign-removals', foreign)) {
    gaps.push({ code: 'sieve-gap-foreign-removals', params: { files: named(foreign) } });
  }
  const consumers = input.mechanics.consumers ?? [];
  const consumerFiles = [...new Set(consumers.flatMap((hit) => hit.files))];
  const consumersFlagged =
    consumerFiles.length > 0 && !cleared('consumers-repo-wide', consumerFiles);
  if (consumersFlagged) {
    gaps.push({
      code: 'sieve-gap-consumers',
      params: {
        tokens: consumers
          .slice(0, NAMED_MAX)
          .map((hit) => hit.token)
          .join(', '),
        files: named(consumerFiles),
      },
    });
  }

  for (const sieve of input.applicable) {
    if (sieve.id === 'merge-tree' || sieve.id === 'foreign-removals') continue;
    if (sieve.id === 'consumers-repo-wide' && consumersFlagged) continue;
    const row = rows.get(sieve.id);
    if (!row) {
      gaps.push({ code: 'sieve-gap-unreported', params: { sieve: sieve.id, lang: SIEVE_LANG } });
    } else if (row.status === 'fail') {
      gaps.push({ code: 'sieve-gap-failed', params: { sieve: sieve.id, evidence: row.evidence } });
    } else if (row.evidence.length < EVIDENCE_MIN) {
      gaps.push({ code: 'sieve-gap-no-evidence', params: { sieve: sieve.id } });
    }
  }
  return gaps;
}

// ---------------------------------------------------------------- выученные сита

/**
 * `proposed` — модель группы вывела сито из треда ревьюера, в задания оно не идёт;
 * `active` — человек принял, и сито едет в задания звеньев (ревью сит, 28.09: текст
 * любого комментатора MR иначе становился постоянным заданием во всех проектах).
 */
export type LearnedSieveStatus = 'proposed' | 'active';

/** Выученное сито в хранилище панели. */
export interface LearnedSieve {
  id: string;
  class: SieveClass;
  status: LearnedSieveStatus;
  scope: 'project' | 'global';
  /** Проект, где сито выучено (для `scope: 'project'`). */
  projectPath?: string;
  /**
   * Модель просила общее сито или тот же блокер всплыл в другом проекте — это
   * совет человеку, а не охват: общим сито делает только он.
   */
  suggestedScope?: 'global';
  trigger: string;
  check: string;
  /** Треды, из которых оно выучено, — доказательство, что блокер был. */
  sources: { thread: string; mr?: string; at: string }[];
  createdAt: string;
  lastSeenAt: string;
}

/** Счёт класса блокеров за месяц: ушло в MR и поймано панелью до MR. */
export interface SieveTallyCell {
  escaped: number;
  caught: number;
}

/** `YYYY-MM` → класс → счёт. */
export type SieveTally = Record<string, Partial<Record<SieveClass, SieveTallyCell>>>;

/** `GET /api/sieves`: выученные сита и счёт; встроенные — `BUILTIN_SIEVES`. */
export interface SievesView {
  learned: LearnedSieve[];
  tally: SieveTally;
}

/** Слова для сравнения: нижний регистр, буквы и цифры, без коротких связок. */
function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

/** Похожесть двух проверок по словам (Жаккар). */
export function checkSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}

/** С этой похожести проверка того же класса — то же сито, а не новое. */
export const SAME_SIEVE_SIMILARITY = 0.5;

/** Почему выученное сито не принято — код для журнала и теста. */
export type LearnedRejection = 'unknown-thread' | 'too-short' | 'too-long';

/**
 * Принять выученное сито. Главное условие — тред: он должен быть среди тех,
 * что панель САМА переслала группе (`relayed`), — иначе сито выдумано. Только
 * точное совпадение: задание просит ссылку «ровно как в списке», а совпадение по
 * хвосту пропускало `"2"` к `…#note_42` и чужой адрес с тем же якорем (ревью сит).
 */
export function acceptLearned(
  row: LearnedSieveRow,
  relayed: readonly string[],
): LearnedRejection | undefined {
  if (!relayed.includes(row.thread.trim())) {
    return 'unknown-thread';
  }
  if (row.check.length < LEARNED_TEXT_MIN || row.trigger.length < LEARNED_TEXT_MIN / 2) {
    return 'too-short';
  }
  if (row.check.length > LEARNED_TEXT_MAX) return 'too-long';
  return undefined;
}

// ---------------------------------------------------------------- задания

/**
 * Абзац сит для задания звена: применимые встроенные (своего звена — делать,
 * остальные — к сведению), что панель уже нашла, выученные и формат отчёта.
 * Пусто — дифф пуст и сит нет.
 */
export function sievePromptBlock(input: {
  stage: SieveStage;
  applicable: readonly SieveDef[];
  learned?: readonly Pick<LearnedSieve, 'class' | 'trigger' | 'check' | 'sources'>[];
  mechanics?: SieveMechanics;
  /** Отчёт прошлых звеньев: пройденное повторять не надо. */
  done?: readonly SieveReportRow[];
}): string {
  const { stage, applicable } = input;
  if (applicable.length === 0 && !input.learned?.length) return '';
  const done = new Set(
    (input.done ?? [])
      .filter((row) => row.status !== 'fail' && row.evidence.length >= EVIDENCE_MIN)
      .map((row) => row.id),
  );
  const own = applicable.filter(
    (sieve) => !done.has(sieve.id) && (stage === 'deliver' || sieve.stage === 'review'),
  );
  const lines = [
    'Sieves before the MR — each comes from a real reviewer blocker. The panel checks the ' +
      'report at delivery: a sieve with no row or no evidence keeps the group from "done".',
  ];
  own.forEach((sieve, index) => lines.push(`${index + 1}. [${sieve.id}] ${sieve.text}`));
  const mechanics = input.mechanics;
  if (mechanics?.consumers?.length) {
    lines.push(
      'The panel found removed names still used outside the diff — fix each consumer or name ' +
        'every file in the consumers-repo-wide row with why it is not a consumer:',
      ...mechanics.consumers.slice(0, 10).map((hit) => `- ${hit.token}: ${hit.files.join(', ')}`),
    );
  }
  if (mechanics?.foreignRemovals?.length) {
    lines.push(
      `The panel found removed lines that landed in main after the group started: ` +
        `${mechanics.foreignRemovals.join(', ')} — restore them, or name every file in the ` +
        'foreign-removals row with why the removal is intended.',
    );
  }
  if (mechanics?.conflicts?.length) {
    lines.push(
      `Merging with fresh main conflicts in: ${mechanics.conflicts.join(', ')} — rebase onto ` +
        'fresh main and resolve.',
    );
  }
  if (input.learned?.length) {
    lines.push('Sieves learned from earlier MR blockers (apply those that fit this change):');
    for (const sieve of input.learned) {
      const seen = sieve.sources.length > 1 ? ` (seen ${sieve.sources.length}×)` : '';
      lines.push(`- [${sieve.class}] when ${sieve.trigger} → ${sieve.check}${seen}`);
    }
  }
  if (own.length > 0) {
    lines.push(
      `Report at the end of the answer in a code block in the language ${SIEVE_LANG}: ` +
        '{"sieves":[{"id":"<sieve id>","status":"pass|fail|n/a","evidence":"command and the line ' +
        'of its output, or why it does not apply"}]} — one row per numbered sieve.',
    );
  }
  return lines.join('\n');
}

/**
 * Хвост задания по MR-тредам: как разложить каждый тред в сито. Ссылку треда
 * брать ровно ту, что дана, — по ней панель проверяет, что блокер настоящий.
 */
export const LEARN_SIEVES_LINE =
  'After the fixes, turn each listed thread into a sieve — the check that would have caught it ' +
  `before the MR. Add to the answer a code block in the language ${SIEVE_LANG} with ` +
  '{"learned":[{"thread":"<the link exactly as listed above>","class":"contract|integration|' +
  'isolation|consumers|boundary|other","scope":"project|global","trigger":"which kind of change ' +
  'produces this blocker","check":"the concrete check to run before the MR"}]}. A thread that ' +
  'is a matter of taste gets no sieve.';
