import { blockLang, blockLangPattern } from './brand.ts';
import { ANSWER_LANGUAGE_LINE } from './model-cascade.ts';
import {
  labelledCut,
  OWNER_PRECEDENCE_LINE,
  OWNER_TEXT_MAX,
  withoutPrecedence,
} from './quality-floor.ts';
import { SPLIT_MAX_GROUPS } from './task-split.ts';
/**
 * Два уровня плана ПЕРЕД работой групп разделения (Т1, 09.09.2026).
 *
 * Уровень 1 — «разбор»: один прогон на потолке в корне репозитория, который
 * видит все группы и код и разводит пересечения: кто чем владеет, какие задачи
 * куда переезжают, кто ждёт кого, что надо спросить у человека. Ответ — блок
 * `agentdeck:split-plan` с JSON.
 *
 * Уровень 2 — «план»: прогон на потолке в копии КАЖДОЙ группы, без права
 * править, — разбор кода под задачу, эталоны, подходы, шаги, проверки. Ответ —
 * блок `agentdeck:plan` с markdown, который уезжает первым сообщением
 * работе.
 *
 * Сабпат без zod и без импортов из соседних сабпатов: правило контрактов —
 * сервер работает без сборки, и сабпаты друг друга не тянут. Поэтому вырезание
 * блоков написано здесь заново, по тем же правилам, что у разделения и ревью.
 */

export const SPLIT_PLAN_BLOCK_LANG = blockLang('split-plan');
export const PLAN_BLOCK_LANG = blockLang('plan');

/** Потолки разбора: всё сверх них — не план, а простыня. */
const MAX_GROUPS = SPLIT_MAX_GROUPS;
const MAX_TASKS = 50;
/** Задача и заметки — текст владельца и разбора: режется только с меткой (`labelledCut`). */
const MAX_TASK = OWNER_TEXT_MAX;
const MAX_OWNS = 40;
const MAX_OWN = 200;
const MAX_NOTES = OWNER_TEXT_MAX;
/**
 * Карта мест группы и общая подготовка (8.3, 8.4): места и способы, а не код —
 * длиннее уже пересказ файлов, который группа всё равно прочтёт сама.
 */
const MAX_MAP = 4_000;
const MAX_SETUP = 2_000;
const MAX_QUESTION = 600;
const MAX_CONFLICTS = 40;
const MAX_WHY = 400;
/** Ключ группы панели (`global:<id>`): длиннее ключей не бывает. */
const MAX_GROUP_KEY = 200;
/** Сколько групп панели разбор видит в каталоге: дальше это уже не выбор, а простыня. */
export const TRIAGE_CATALOG_MAX = 40;
/**
 * План группы. Раньше 12k с молчаливой обрезкой: длинный план терял шаги и
 * критерии приёмки посреди слова, а работа считала его целым. Теперь потолок —
 * защита от мусора, и обрезка подписана.
 */
export const PLAN_MAX_CHARS = OWNER_TEXT_MAX;
/** Задание в связи: столько панель хранит, чтобы собрать первое сообщение работе. */
export const TASK_MAX_CHARS = OWNER_TEXT_MAX;

/** Что разбор сказал про одну группу. Индексы — с нуля, как в предложении. */
export interface SplitPlanGroup {
  index: number;
  /** Файлы и модули, которыми владеет ТОЛЬКО эта группа. */
  owns: string[];
  /** Задачи после перераспределения; пусто — как в предложении. */
  tasks: string[];
  /** Что делают соседи, на какие интерфейсы полагаться, чего не трогать. */
  notes?: string;
  /**
   * Карта мест (8.3): файлы и строки правки, где вызывается изменяемое, образец
   * в репозитории, команды проверки этих мест. Разбор читает код ради
   * пересечений всё равно — найденное уходит группе, а не ищется заново.
   */
  map?: string;
  /** Группы, чья работа должна лечь раньше: копия ветвится от их ветки. */
  after: number[];
  /** Вопрос человеку — группа не стартует, пока не ответят. */
  hold?: string;
  /**
   * Группа панели, которую разбор выбрал для этой группы по её `when` (выбор
   * группы чата — `auto`). Ключ как есть; сверяет его с предложенным каталогом
   * сервер — незнакомый отбрасывается.
   */
  groupKey?: string;
}

/** Пересечение, которое разбор кому-то отдал. */
export interface SplitPlanConflict {
  paths: string[];
  /** Группа-владелец (индекс с нуля). */
  resolvedBy: number;
  why: string;
}

export interface SplitPlan {
  groups: SplitPlanGroup[];
  conflicts: SplitPlanConflict[];
  /** Порядок старта/слияния — индексы групп. */
  order: number[];
  /**
   * Общая подготовка (8.4), одна на разделение: как поднять и проверить проект,
   * адреса и порты, способ входа на стенд — без самих секретов.
   */
  setup?: string;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/** Текст, который читает агент как инструкцию: обрезка только с меткой. */
function prose(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? labelledCut(trimmed, limit) : undefined;
}

function list(
  value: unknown,
  limit: number,
  itemLimit: number,
  cut: (value: unknown, limit: number) => string | undefined = text,
): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .slice(0, limit)
    .map((item) => cut(item, itemLimit))
    .filter((item): item is string => Boolean(item));
}

/**
 * Ссылка на группу: номер (в промпте группы нумеруются С ЕДИНИЦЫ, модель так и
 * отвечает) либо название. `titles` — названия из предложения по порядку.
 * Не разобрано — `undefined`: ссылка отбрасывается, не угадывается.
 */
function groupRef(value: unknown, titles: readonly string[] | undefined): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const index = value - 1;
    // Без названий (показ блока в ленте) предложения рядом нет — годится
    // любой номер в пределах разделения.
    return index >= 0 && index < (titles ? titles.length : MAX_GROUPS) ? index : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const asNumber = /^#?\d+$/.test(trimmed) ? Number(trimmed.replace('#', '')) : undefined;
    if (asNumber !== undefined) return groupRef(asNumber, titles);
    const byTitle = (titles ?? []).findIndex(
      (title) => title.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    return byTitle >= 0 ? byTitle : undefined;
  }
  return undefined;
}

function refList(value: unknown, titles: readonly string[] | undefined): number[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: number[] = [];
  for (const item of raw) {
    const index = groupRef(item, titles);
    if (index !== undefined && !out.includes(index)) out.push(index);
  }
  return out;
}

/**
 * Разбор блока уровня 1. Терпим к форме (номер или название группы, `hold`
 * строкой или объектом с `question`), строг к смыслу: группа без узнаваемой
 * ссылки отбрасывается, а не привязывается наугад.
 *
 * `titles` нужны для ссылок по названию и для проверки диапазона: так разбирает
 * конвейер, у которого предложение под рукой. Без них разбирает ЛЕНТА — ей
 * нужно лишь показать блок карточкой, а не завести по нему копии, поэтому
 * номера принимаются любые в пределах разделения, а ссылка по названию
 * отбрасывается: сопоставить её не с чем.
 */
export function parseSplitPlan(raw: unknown, titles?: readonly string[]): SplitPlan | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;

  const groupsRaw = Array.isArray(source.groups) ? source.groups : [];
  const groups: SplitPlanGroup[] = [];
  for (const item of groupsRaw.slice(0, MAX_GROUPS)) {
    if (!item || typeof item !== 'object') continue;
    const group = item as Record<string, unknown>;
    const index = groupRef(
      group.index ?? group.group ?? group.id ?? group.n ?? group.title,
      titles,
    );
    if (index === undefined || groups.some((known) => known.index === index)) continue;

    const holdRaw = group.hold;
    const hold =
      typeof holdRaw === 'string'
        ? text(holdRaw, MAX_QUESTION)
        : holdRaw && typeof holdRaw === 'object'
          ? text((holdRaw as { question?: unknown }).question, MAX_QUESTION)
          : undefined;
    const notes = prose(group.notes ?? group.note, MAX_NOTES);
    const map = prose(group.map ?? group.places, MAX_MAP);
    const groupKey = text(group.groupKey, MAX_GROUP_KEY);

    groups.push({
      index,
      owns: list(group.owns ?? group.files, MAX_OWNS, MAX_OWN),
      tasks: list(group.tasks, MAX_TASKS, MAX_TASK, prose),
      ...(notes ? { notes } : {}),
      ...(map ? { map } : {}),
      after: refList(group.after ?? group.dependsOn, titles).filter((ref) => ref !== index),
      ...(hold ? { hold } : {}),
      ...(groupKey ? { groupKey } : {}),
    });
  }
  if (groups.length === 0) return undefined;

  const conflictsRaw = Array.isArray(source.conflicts) ? source.conflicts : [];
  const conflicts: SplitPlanConflict[] = [];
  for (const item of conflictsRaw.slice(0, MAX_CONFLICTS)) {
    if (!item || typeof item !== 'object') continue;
    const conflict = item as Record<string, unknown>;
    const paths = list(conflict.paths ?? conflict.path ?? conflict.files, MAX_OWNS, MAX_OWN);
    const resolvedBy = groupRef(conflict.resolvedBy ?? conflict.owner ?? conflict.group, titles);
    if (paths.length === 0 || resolvedBy === undefined) continue;
    conflicts.push({
      paths,
      resolvedBy,
      why: text(conflict.why ?? conflict.reason, MAX_WHY) ?? '',
    });
  }

  const setup = prose(source.setup, MAX_SETUP);
  return { groups, conflicts, order: refList(source.order, titles), ...(setup ? { setup } : {}) };
}

/** Что осталось от ответа после вырезания блока и что из него разобрано. */
export interface SplitPlanScan {
  text: string;
  plan?: SplitPlan;
  rejected: number;
}

const SPLIT_PLAN_OPEN = new RegExp(
  `(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('split-plan')}[ \\t]*\\r?\\n`,
);
const CLOSE = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/;

/**
 * Вырезать блок разбора из ответа. Правила те же, что у разделения и ревью:
 * закрытый и разобранный — уходит из показа; закрытый и непонятый — остаётся
 * как есть и считается; недописанный — прячется до конца текста.
 */
export function scanSplitPlanBlocks(source: string, titles?: readonly string[]): SplitPlanScan {
  let plan: SplitPlan | undefined;
  let rejected = 0;
  let rest = source;
  let out = '';

  for (;;) {
    const open = SPLIT_PLAN_OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }
    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);

    const close = CLOSE.exec(rest.slice(bodyStart));
    if (!close) break;

    const body = rest.slice(bodyStart, bodyStart + close.index);
    const parsed = parseSplitPlan(body, titles);
    if (parsed) {
      plan = parsed;
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }
    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), ...(plan ? { plan } : {}), rejected };
}

/** Что осталось от ответа планировщика группы и сам план. */
export interface PlanScan {
  text: string;
  /** Текст плана (markdown) без обёртки; нет — блока не было. */
  plan?: string;
}

const PLAN_OPEN = new RegExp(
  `(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('plan')}[ \\t]*\\r?\\n`,
);

/**
 * Вырезать план группы. План — markdown, и внутри него бывают свои блоки
 * кода с теми же тройными кавычками, поэтому закрывающей считается ПОСЛЕДНЯЯ
 * строка-кавычка после открытия, а не первая: инструкция велит заканчивать
 * ответ блоком, и всё после него — тоже план. Недописанный блок (кавычки
 * закрывающей нет вовсе) прячется до конца, как и у остальных блоков.
 */
export function scanPlanBlocks(source: string): PlanScan {
  const open = PLAN_OPEN.exec(source);
  if (!open) return { text: source.trim() };

  const lead = (open[1] ?? '').length;
  const bodyStart = open.index + open[0].length;
  const before = source.slice(0, open.index + lead);
  const rest = source.slice(bodyStart);

  let closeAt = -1;
  let closeLen = 0;
  const closer = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/g;
  for (;;) {
    const match = closer.exec(rest);
    if (!match) break;
    closeAt = match.index + (match[1] ?? '').length;
    closeLen = match[0].length - (match[1] ?? '').length;
    if (match[0].length === 0) break;
  }
  if (closeAt < 0) return { text: before.trim() };

  const plan = labelledCut(rest.slice(0, closeAt).trim(), PLAN_MAX_CHARS);
  const after = rest.slice(closeAt + closeLen);
  const textOut = `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim();
  return { text: textOut, ...(plan ? { plan } : {}) };
}

/** Группа предложения глазами применения: ровно то, что нужно для переноса. */
export interface PlannableGroup {
  title: string;
  tasks: string[];
}

/** Группа после применения разбора. */
export interface AppliedSplitGroup {
  index: number;
  tasks: string[];
  owns: string[];
  notes?: string;
  after: number[];
  hold?: string;
  /** Выбор разбора из каталога — как в блоке, ещё не сверенный с каталогом. */
  groupKey?: string;
}

export interface AppliedSplitPlan {
  groups: AppliedSplitGroup[];
  order: number[];
  conflicts: SplitPlanConflict[];
  /** Что панель поправила в разборе: потерянные задачи, циклы, битые ссылки. */
  repairs: string[];
}

/** Сравнение задач «примерно»: планировщик обязан переносить дословно, но переносы и регистр не в счёт. */
function keyOf(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Короче — слишком общее начало («починить»), чтобы считать задачи одной. */
const SAME_TASK_PREFIX_MIN = 24;

/** Одна и та же задача, если нормализованные тексты совпадают или один начинается другим (60 знаков). */
function sameTask(a: string, b: string): boolean {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Обрезанная копия короче 60 знаков — та же задача, а не новая (F7).
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (shorter.length >= SAME_TASK_PREFIX_MIN && longer.startsWith(shorter)) return true;
  const head = 60;
  return ka.slice(0, head) === kb.slice(0, head);
}

/**
 * Заметки группы из разбора: его слова о соседях, карта мест группы и общая
 * подготовка. Всё — заметками, а не отдельными полями: заметки уже доходят до
 * плана, работы, поднятой работы и группы в чужом CLI (`composeGroupNotes`).
 */
function triageNotes(planned: SplitPlanGroup | undefined, setup: string | undefined): string {
  return [
    planned?.notes,
    planned?.map &&
      `Map of places from the triage — start from it, do not search again for what it names:\n${planned.map}`,
    setup && `Shared setup, found once by the triage for every group:\n${setup}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Применить разбор к предложению. Чистая функция — сюда не входит ни git, ни
 * хранилище; результат идёт и в запуск, и в запись конвейера, и на экран.
 *
 * Панель НЕ доверяет разбору три вещи:
 * - задача, которой нет ни в одной группе разбора, возвращается в свою
 *   исходную группу — потерять работу молча хуже, чем повторить строку;
 * - задача, попавшая в две группы, остаётся в первой по порядку разбора;
 * - `after`, замыкающее цикл, отбрасывается (ждать друг друга — стоять вечно),
 *   как и ссылка на саму себя или на неизвестную группу.
 * Каждая починка названа в `repairs`: человек видит их в ленте разбора.
 */
export function applySplitPlan(
  groups: readonly PlannableGroup[],
  plan: SplitPlan,
): AppliedSplitPlan {
  const repairs: string[] = [];
  const byIndex = new Map(plan.groups.map((group) => [group.index, group]));

  // Задача разбора, похожая на исходную, но не равная ей, — пересказ: в работу
  // уходят слова исходной задачи (F7, 12.10.2026: разбор обрезал «…и при этом
  // ОБЯЗАТЕЛЬНО добавить тест», и хвост пропадал молча).
  const originals = groups.flatMap((group) => group.tasks);
  const verbatim = (task: string): string => {
    const original = originals.find((known) => sameTask(known, task));
    if (!original || keyOf(original) === keyOf(task)) return task;
    repairs.push(`задача «${task.slice(0, 60)}» в разборе сокращена — оставлен исходный текст`);
    return original;
  };

  // Задачи: сперва то, что назначил разбор, с вычетом повторов между группами.
  const seen: string[] = [];
  const tasksOf = groups.map((group, index) => {
    const planned = byIndex.get(index);
    const source = planned && planned.tasks.length > 0 ? planned.tasks.map(verbatim) : group.tasks;
    const own: string[] = [];
    for (const task of source) {
      if (own.some((known) => sameTask(known, task))) continue;
      // Общая строка (итоговая проверка 25.09, D3): «Проверить исправление: …»
      // стояла в каждой группе ещё в предложении — это не повтор разбора, и у
      // групп после первой она пропадать не должна.
      if (group.tasks.some((mine) => sameTask(mine, task))) {
        if (!seen.some((known) => sameTask(known, task))) seen.push(task);
        own.push(task);
        continue;
      }
      if (seen.some((known) => sameTask(known, task))) {
        if (planned && planned.tasks.length > 0) {
          repairs.push(
            `задача «${task.slice(0, 60)}» повторялась в двух группах — оставлена в первой`,
          );
        }
        continue;
      }
      seen.push(task);
      own.push(task);
    }
    return own;
  });

  // Потерянные задачи возвращаются домой.
  groups.forEach((group, index) => {
    for (const task of group.tasks) {
      if (seen.some((known) => sameTask(known, task))) continue;
      seen.push(task);
      tasksOf[index]?.push(task);
      repairs.push(
        `задача «${task.slice(0, 60)}» пропала из разбора — возвращена в группу «${group.title}»`,
      );
    }
  });

  // Зависимости без циклов: ребро, замыкающее цикл, отбрасывается.
  const after = groups.map((_, index) =>
    (byIndex.get(index)?.after ?? []).filter(
      (ref) => ref !== index && ref >= 0 && ref < groups.length,
    ),
  );
  const reaches = (from: number, target: number, visited = new Set<number>()): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (after[from] ?? []).some((next) => reaches(next, target, visited));
  };
  groups.forEach((group, index) => {
    after[index] = (after[index] ?? []).filter((ref) => {
      if (reaches(ref, index)) {
        repairs.push(
          `«${group.title}» и «${groups[ref]?.title ?? ref + 1}» ждали друг друга — ожидание снято`,
        );
        return false;
      }
      return true;
    });
  });

  // Порядок: заявленный, дополненный топологией по `after`.
  const order: number[] = [];
  const push = (index: number, stack = new Set<number>()): void => {
    if (order.includes(index) || stack.has(index)) return;
    stack.add(index);
    for (const dep of after[index] ?? []) push(dep, stack);
    order.push(index);
  };
  for (const index of plan.order) if (index >= 0 && index < groups.length) push(index);
  groups.forEach((_, index) => push(index));

  return {
    groups: groups.map((_, index) => {
      const planned = byIndex.get(index);
      const notes = triageNotes(planned, plan.setup);
      return {
        index,
        tasks: tasksOf[index] ?? [],
        owns: planned?.owns ?? [],
        ...(notes ? { notes } : {}),
        after: after[index] ?? [],
        ...(planned?.hold ? { hold: planned.hold } : {}),
        ...(planned?.groupKey ? { groupKey: planned.groupKey } : {}),
      };
    }),
    order,
    conflicts: plan.conflicts.filter((conflict) => conflict.resolvedBy < groups.length),
    repairs,
  };
}

/** Группа, как её видит промпт разбора. */
export interface TriageGroupInput {
  title: string;
  branch: string;
  tasks: string[];
  brief?: string;
  kind?: string;
}

/** Группа панели, которую разбор может выбрать группе разделения. */
export interface TriageGroupCatalogEntry {
  key: string;
  name: string;
  /** Когда группа подходит; нет — в каталоге одно имя. */
  when?: string;
  /**
   * Сценарий: шаги — вся работа, по порядку, без стадий конвейера. Разбору это
   * нужно знать: сценарий заменяет порядок работы группы разделения, а не
   * дополняет его.
   */
  scenario?: true;
  /**
   * Встроенная группа панели (каталог доставки): запасная. Своя группа человека
   * или проекта с подходящим `when` выигрывает у неё.
   */
  builtin?: true;
}

/**
 * Каталог групп панели для разбора — английской инструкцией: её читает только
 * модель. Выбирать лишь при явном совпадении `when`: промах хуже пропуска —
 * чужая группа принесла бы группе разделения чужой порядок работы.
 */
function catalogLines(catalog: readonly TriageGroupCatalogEntry[]): string[] {
  if (catalog.length === 0) return [];
  return [
    'Panel group catalog. A panel group is a bundle of rules, skills and path steps a split group ' +
      'can run under. For each split group, pick one ONLY when its "when" clearly fits the ' +
      'tasks of that group; otherwise pick none. A group listed without "when" is picked only when its ' +
      'name alone makes the fit obvious. Never invent a key.' +
      (catalog.some((entry) => entry.builtin)
        ? ' A built-in group is a fallback: a project or user group whose "when" fits as well wins.'
        : ''),
    ...catalog.slice(0, TRIAGE_CATALOG_MAX).map((entry) => {
      const line = entry.when?.trim()
        ? `- ${entry.key} — ${entry.name} — when: ${entry.when.trim()}`
        : `- ${entry.key} — ${entry.name}`;
      const marked = entry.builtin ? `${line} — built-in` : line;
      return entry.scenario
        ? `${marked} — scenario: its steps, in order, are the whole work of the group`
        : marked;
    }),
    'Put the pick as "groupKey":"<key from this list>" in the object of that group in the block; ' +
      'leave the field out when nothing clearly fits.',
    '',
  ];
}

/**
 * Задание уровня 1 — разбор разделения на потолке в корне репозитория.
 *
 * Многострочность безопасна: это промпт прогона (уезжает файлом), а не
 * системная дописка в argv.
 */
export function triageStagePrompt(input: {
  shared?: string;
  groups: TriageGroupInput[];
  /** Каталог групп панели; нет или пуст — разбор группу не выбирает. */
  catalog?: readonly TriageGroupCatalogEntry[];
}): string {
  const groups = input.groups.map((group, index) => {
    const lines = [
      `Group ${index + 1}: "${group.title}" (branch ${group.branch}${group.kind ? `, class ${group.kind}` : ''})`,
      ...group.tasks.map((task, n) => `  ${n + 1}. ${task}`),
    ];
    if (group.brief) lines.push(`  Brief: ${group.brief}`);
    return lines.join('\n');
  });

  return [
    'This is the triage of a task split BEFORE the work. The human agreed to spread the work over ' +
      'groups — each runs in its own copy of the repository and its own branch, in parallel and ' +
      'without seeing its neighbours. Your job is to read the code and separate the overlaps BEFORE ' +
      'the start, so that two branches do not overwrite one change and one task is not done twice.',
    'EDIT NOTHING: only read (files, git log, code search). The panel creates branches, copies and chats.',
    '',
    input.shared ? `Context shared by the groups:\n${input.shared}\n` : '',
    'The groups as the agent proposed them:',
    ...groups,
    '',
    'Do this:',
    '1. For each task, find the files and modules it will touch. Keep what you found for the ' +
      "group's map: file:line of what changes, where the changed code is called, the reference in " +
      'the repository to copy, the test and screenshot commands for those places. The group starts ' +
      'from the map instead of searching again — places and commands only, no code and no retelling.',
    '2. Find the overlaps between groups: one file, one module, one contract shared by two groups.',
    "3. Give each overlap to ONE owner group; write into the neighbours' notes what to rely on " +
      "and what not to touch, and if their work is impossible without the owner's changes, give them after.",
    '4. Move a task that landed in the wrong group: each task lives in EXACTLY one group, move the ' +
      'task text VERBATIM. Do not change group names or branches.',
    '5. hold — only for a question you cannot decide (two incompatible readings, a product ' +
      'decision). What you can decide yourself — decide and write it into notes.',
    '6. Once for all groups, the setup every group would otherwise find out on its own: how the ' +
      'project is started and checked here (commands, dev-server ports, stand addresses) and how ' +
      'to log in to the stand — name the method or the file that holds the access, never the ' +
      'secret itself. Only what you saw in the repository; leave out what you did not find.',
    '',
    `End your answer with EXACTLY ONE code block in the language ${SPLIT_PLAN_BLOCK_LANG} containing JSON of the form ` +
      '{"groups":[{"index":1,"owns":["path/or/module"],"tasks":["task verbatim"],' +
      '"notes":"what the neighbours do, which interfaces to rely on, what not to touch",' +
      '"map":"file:line — what changes; callers; reference; check commands",' +
      '"after":[2],"hold":{"question":"question to the human"}}],' +
      '"conflicts":[{"paths":["file"],"resolvedBy":1,"why":"why this group"}],"order":[2,1,3],' +
      '"setup":"start and check commands, ports, stand address, login method"}. ' +
      'Group numbers as above, starting from one. after — the numbers of groups whose work must land ' +
      "first (this group's copy branches off their branch). order — the order of start and merge. " +
      'Do not set hold or after without need: a group without them starts at once.',
    ...catalogLines(input.catalog ?? []),
    'Before the block, briefly tell the human what overlapped and how it was separated. Nothing after the block.',
    ANSWER_LANGUAGE_LINE,
    OWNER_PRECEDENCE_LINE,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/** Отчёт о предшественниках — в заметки группы, которая ждала их. */
export interface PredecessorNote {
  title: string;
  branch: string;
  /** Цепочка предшественника кончилась ошибкой или остановкой. */
  failed?: boolean;
  /**
   * Цепочка предшественника НЕ кончилась: человек отпустил эту группу руками.
   * Отдельно от `failed` намеренно — «упал» и «ещё пишет» требуют от агента
   * разного: в первом случае работы может не быть вовсе, во втором она растёт
   * под ним прямо сейчас.
   */
  unfinished?: boolean;
  /**
   * Файлы, которые предшественник уже задел, — то, ради чего сверка веток и
   * считается: «этот файл уже трогали» меняет работу преемника сильнее, чем имя
   * ветки. Список обрезан потолком, настоящий счёт — в `filesTotal`.
   */
  files?: string[];
  /** Сколько файлов задето всего: список короче — значит, обрезан. */
  filesTotal?: number;
}

/**
 * Сколько задетых файлов называть предшественнику в заметках. Потолок здесь, а
 * не у вызывающего: раздувать задание сотней путей нельзя, а решает это формат
 * заметки, а не тот, кто её собирает.
 */
export const PREDECESSOR_FILES_SHOWN = 20;

/** «a.ts, b.ts и ещё 5» — файлы предшественника с потолком. */
function touchedFiles(item: PredecessorNote): string {
  const shown = (item.files ?? []).slice(0, PREDECESSOR_FILES_SHOWN);
  const total = item.filesTotal ?? shown.length;
  if (shown.length === 0) {
    // Счёт без имён — законное состояние: сверка веток считает и те группы,
    // чьи пути в запись не поместились.
    return total > 0 ? `; files touched: ${total}` : '';
  }
  const rest = Math.max(0, total - shown.length);
  return `; already touched: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/**
 * Заметки группы ОДНОЙ строкой: что сказал разбор, кто работал раньше и от
 * какой ветки отведена копия, что спросили у человека и что он ответил.
 *
 * Собираются один раз при запуске группы и ложатся в связь (`ChatLink.notes`):
 * их читают оба прогона группы — план и работа, — а второй собирается из связи,
 * когда контекста запуска уже нет.
 */
export function composeGroupNotes(input: {
  notes?: string;
  predecessors?: PredecessorNote[];
  base?: string;
  holdAnswer?: { question: string; answer: string };
}): string | undefined {
  const parts: string[] = [];
  if (input.notes) parts.push(input.notes);
  if (input.predecessors && input.predecessors.length > 0) {
    const names = input.predecessors
      .map((item) => {
        const state = item.failed
          ? ', ended with an error or a stop — check the state'
          : item.unfinished
            ? ', its chain did NOT finish — the human released you without waiting for it'
            : '';
        return `"${item.title}" (branch ${item.branch}${state}${touchedFiles(item)})`;
      })
      .join(', ');
    parts.push(
      `Before this group, these worked: ${names}.${input.base ? ` The copy branches off ${input.base} — their changes are already here.` : ''} Merging the branches stays with the human.`,
    );
  }
  if (input.holdAnswer) {
    parts.push(
      `Triage question to the human: ${input.holdAnswer.question}\nThe human's answer: ${input.holdAnswer.answer}`,
    );
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Границы группы из разбора — строками в задание уровня 2 и работе. */
function boundaries(input: { owns?: string[]; notes?: string }): string[] {
  const lines: string[] = [];
  if (input.owns && input.owns.length > 0) {
    lines.push(`This group owns (edit only here): ${input.owns.join(', ')}.`);
  }
  if (input.notes) lines.push(`Triage notes:\n${input.notes}`);
  return lines;
}

/**
 * Задание работы, начатой без плана (работа на потолке план пропускает):
 * границы и заметки разбора, которые иначе дошли бы до неё только через план.
 */
export function withGroupBoundaries(
  prompt: string,
  input: { owns?: string[]; notes?: string },
): string {
  const lines = boundaries(input);
  return lines.length > 0 ? `${prompt}\n\n${lines.join('\n\n')}` : prompt;
}

/**
 * Задание уровня 2 — план группы на потолке в её копии, без права правок.
 * Первое сообщение чата «<группа> · план».
 */
export function planStagePrompt(input: {
  title: string;
  /** Задание группы целиком (с преамбулой копии). */
  task: string;
  owns?: string[];
  /** Заметки уже собраны `composeGroupNotes`. */
  notes?: string;
  branch?: string;
  kind?: string;
  /** Чем пойдёт работа — планировщику полезно знать, для кого пишет. */
  workModel?: string;
}): string {
  const where = input.branch ? ` on branch ${input.branch}` : '';
  return [
    `Work plan for the group "${input.title}"${where}.`,
    'This is preparation BEFORE the work: a separate run does the work' +
      (input.workModel ? ` on the model ${input.workModel}` : '') +
      ', it will not have your context — it gets the task and your plan, and nothing else.',
    'EDIT NOTHING: read code, search, run read-only checks. Edits are not your stage.',
    '',
    "The group's task:",
    withoutPrecedence(input.task),
    '',
    ...boundaries(input),
    input.kind ? `Class of work in the panel's view: ${input.kind}.` : '',
    '',
    'Write the plan so that one can work by it without seeing this conversation:',
    '1. Code analysis for the task: which modules are touched, how they are built, where the input and output are. ' +
      'When the triage notes carry a map of places, start from it: check its places and add what it missed — do not search again for what it names.',
    '2. References in the repository: how similar things are already done here (files, patterns) — the work copies them rather than inventing.',
    '3. At least two approaches with their strengths and weaknesses, and the choice of the strong one with the reasoning.',
    '4. Steps in order, each with the files and lines it touches and a check after it (a command or what to look at).',
    // U13: критерии — по пунктам владельца, иначе ревью сверяет работу с
    // пересказом плана, а не с тем, что просили; уровень проверки называется до
    // первой правки (глобальное правило владельца), а не подбирается под итог.
    "5. Acceptance criteria — what counts as done, one for every point of the task (when it carries the owner's request, every point of it: a condition, a check, a depth, a format or a permission the owner named is a point too).",
    '6. Verification level, named before the first edit: which check proves each criterion (a unit or integration test, a live run on the stand, a command and the output that counts) and what would make it go red.',
    '7. "Do not touch": the boundaries from the triage and everything you found yourself.',
    '8. Open questions, if any remain — with your recommended answer.',
    '',
    `End your answer with EXACTLY ONE code block in the language ${PLAN_BLOCK_LANG} containing the plan in markdown, ` +
      'as long as the work needs and no longer. Do not use triple backticks inside the plan ' +
      '(commands in single ones). Nothing after the block.',
    ANSWER_LANGUAGE_LINE,
    OWNER_PRECEDENCE_LINE,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Первое сообщение РАБОТЕ после плана: задание + границы + план. План
 * не получен — сказано прямо, чтобы агент планировал сам, а не ждал.
 */
export function workAfterPlanPrompt(input: {
  task: string;
  owns?: string[];
  notes?: string;
  plan?: string;
}): string {
  return [
    withoutPrecedence(input.task),
    '',
    ...boundaries(input),
    '',
    input.plan
      ? 'The plan was written in advance by the ceiling model in this same copy — follow it step by ' +
        'step, with a check after each step. Deviate only if the code says otherwise, and name the ' +
        'deviation in your answer. Open the places the plan and the map name directly; search the ' +
        'repository only for what they do not name.\n\n' +
        `Plan:\n${input.plan}`
      : "The panel did not receive this group's plan (the plan run gave no block or did not finish) — " +
        'plan yourself: first the code analysis and references, then steps with a check after each.',
    '',
    OWNER_PRECEDENCE_LINE,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Первое сообщение РАБОТЕ, поднятой на потолок (F4, 12.10.2026). Понижённой
 * работе обещано: упрёшься — остановись, работа продолжится на модели сильнее.
 * Вот это продолжение: то же задание и границы, а ответ остановившейся работы —
 * подсказка, а не приговор: остановить её могла и слабость модели, и настоящая
 * развилка, которую решает владелец.
 */
export function raisedWorkPrompt(input: {
  task: string;
  owns?: string[];
  notes?: string;
  plan?: string;
  /** Ответ остановившейся понижённой работы. */
  report: string;
}): string {
  const report = input.report.trim();
  return [
    withoutPrecedence(input.task),
    '',
    ...boundaries(input),
    '',
    input.plan ? `Plan written in advance for this group:\n${input.plan}` : undefined,
    '',
    'A model below this one was given this task in this same copy and stopped without changing ' +
      'anything. Do the task yourself at full strength. Read its report as a lead, not as a ' +
      'verdict: what it called too hard may be within reach, and what it called blocked has to be ' +
      'checked, not repeated. A decision only the owner can take — name it with the evidence and ' +
      'end the turn.',
    ...(report ? ['', `Report of the stopped run:\n${labelledCut(report, TASK_MAX_CHARS)}`] : []),
    '',
    OWNER_PRECEDENCE_LINE,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
