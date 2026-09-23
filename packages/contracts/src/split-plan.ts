import { blockLang, blockLangPattern } from './brand.ts';
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
const MAX_TASK = 2_000;
const MAX_OWNS = 40;
const MAX_OWN = 200;
const MAX_NOTES = 2_000;
const MAX_QUESTION = 600;
const MAX_CONFLICTS = 40;
const MAX_WHY = 400;
/** План группы: 12k знаков — дальше это не план, а второй разговор. */
export const PLAN_MAX_CHARS = 12_000;
/** Задание в связи: столько панель хранит, чтобы собрать первое сообщение работе. */
export const TASK_MAX_CHARS = 16_000;

/** Что разбор сказал про одну группу. Индексы — с нуля, как в предложении. */
export interface SplitPlanGroup {
  index: number;
  /** Файлы и модули, которыми владеет ТОЛЬКО эта группа. */
  owns: string[];
  /** Задачи после перераспределения; пусто — как в предложении. */
  tasks: string[];
  /** Что делают соседи, на какие интерфейсы полагаться, чего не трогать. */
  notes?: string;
  /** Группы, чья работа должна лечь раньше: копия ветвится от их ветки. */
  after: number[];
  /** Вопрос человеку — группа не стартует, пока не ответят. */
  hold?: string;
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
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function list(value: unknown, limit: number, itemLimit: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .slice(0, limit)
    .map((item) => text(item, itemLimit))
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
    const notes = text(group.notes ?? group.note, MAX_NOTES);

    groups.push({
      index,
      owns: list(group.owns ?? group.files, MAX_OWNS, MAX_OWN),
      tasks: list(group.tasks, MAX_TASKS, MAX_TASK),
      ...(notes ? { notes } : {}),
      after: refList(group.after ?? group.dependsOn, titles).filter((ref) => ref !== index),
      ...(hold ? { hold } : {}),
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

  return { groups, conflicts, order: refList(source.order, titles) };
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

  const plan = rest.slice(0, closeAt).trim().slice(0, PLAN_MAX_CHARS);
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

/** Одна и та же задача, если нормализованные тексты совпадают или один начинается другим (60 знаков). */
function sameTask(a: string, b: string): boolean {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const head = 60;
  return ka.slice(0, head) === kb.slice(0, head);
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

  // Задачи: сперва то, что назначил разбор, с вычетом повторов между группами.
  const seen: string[] = [];
  const tasksOf = groups.map((group, index) => {
    const planned = byIndex.get(index);
    const source = planned && planned.tasks.length > 0 ? planned.tasks : group.tasks;
    const own: string[] = [];
    for (const task of source) {
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
      return {
        index,
        tasks: tasksOf[index] ?? [],
        owns: planned?.owns ?? [],
        ...(planned?.notes ? { notes: planned.notes } : {}),
        after: after[index] ?? [],
        ...(planned?.hold ? { hold: planned.hold } : {}),
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

/**
 * Задание уровня 1 — разбор разделения на потолке в корне репозитория.
 *
 * Многострочность безопасна: это промпт прогона (уезжает файлом), а не
 * системная дописка в argv.
 */
export function triageStagePrompt(input: { shared?: string; groups: TriageGroupInput[] }): string {
  const groups = input.groups.map((group, index) => {
    const lines = [
      `Группа ${index + 1}: «${group.title}» (ветка ${group.branch}${group.kind ? `, класс ${group.kind}` : ''})`,
      ...group.tasks.map((task, n) => `  ${n + 1}. ${task}`),
    ];
    if (group.brief) lines.push(`  Памятка: ${group.brief}`);
    return lines.join('\n');
  });

  return [
    'Это разбор разделения задач ПЕРЕД работой. Человек согласился развести работу по группам — ' +
      'каждая пойдёт в своей копии репозитория и своей ветке, параллельно и не видя соседей. ' +
      'Твоя задача — прочитать код и развести пересечения ДО старта, чтобы две ветки не перетирали ' +
      'одну правку и одна задача не делалась дважды.',
    'НИЧЕГО НЕ ПРАВЬ: только читай (файлы, git log, поиск по коду). Ветки, копии и чаты заводит панель.',
    '',
    input.shared ? `Общий контекст групп:\n${input.shared}\n` : '',
    'Группы, как их предложил агент:',
    ...groups,
    '',
    'Сделай:',
    '1. Для каждой задачи найди файлы и модули, которые она заденет.',
    '2. Найди пересечения между группами: один файл, один модуль, один контракт у двух групп.',
    '3. Каждое пересечение отдай ОДНОЙ группе-владельцу; соседям запиши в notes, на что полагаться ' +
      'и чего не трогать, а если их работа невозможна без правок владельца — поставь им after.',
    '4. Задачу, попавшую не в ту группу, перенеси: каждая задача живёт РОВНО в одной группе, ' +
      'текст задачи переноси ДОСЛОВНО. Названия и ветки групп не меняй.',
    '5. hold — только для вопроса, который ты решить не можешь (две несовместимые трактовки, ' +
      'решение о продукте). Что можешь решить сам — реши и запиши в notes.',
    '',
    `Закончи ответ РОВНО ОДНИМ блоком кода с языком ${SPLIT_PLAN_BLOCK_LANG}, внутри — JSON вида ` +
      '{"groups":[{"index":1,"owns":["путь/или/модуль"],"tasks":["задача дословно"],' +
      '"notes":"что делают соседи, на какие интерфейсы полагаться, чего не трогать",' +
      '"after":[2],"hold":{"question":"вопрос человеку"}}],' +
      '"conflicts":[{"paths":["файл"],"resolvedBy":1,"why":"почему этой группе"}],"order":[2,1,3]}. ' +
      'Номера групп — как выше, с единицы. after — номера групп, чья работа должна лечь раньше ' +
      '(копия этой группы ветвится от их ветки). order — порядок старта и слияния. ' +
      'hold и after не ставь без нужды: группа без них стартует сразу.',
    'Перед блоком коротко расскажи человеку, что пересекалось и как разведено. После блока — ничего.',
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
    return total > 0 ? `; задето файлов: ${total}` : '';
  }
  const rest = Math.max(0, total - shown.length);
  return `; уже задеты: ${shown.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
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
          ? ', завершилась ошибкой или остановкой — проверь состояние'
          : item.unfinished
            ? ', цепочка НЕ кончилась — человек отпустил тебя, не дожидаясь её'
            : '';
        return `«${item.title}» (ветка ${item.branch}${state}${touchedFiles(item)})`;
      })
      .join(', ');
    parts.push(
      `Раньше этой группы работали: ${names}.${input.base ? ` Копия отведена от ветки ${input.base} — их правки уже здесь.` : ''} Слияние веток остаётся человеку.`,
    );
  }
  if (input.holdAnswer) {
    parts.push(
      `Вопрос разбора человеку: ${input.holdAnswer.question}\nОтвет человека: ${input.holdAnswer.answer}`,
    );
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Границы группы из разбора — строками в задание уровня 2 и работе. */
function boundaries(input: { owns?: string[]; notes?: string }): string[] {
  const lines: string[] = [];
  if (input.owns && input.owns.length > 0) {
    lines.push(`Владение этой группы (правь только здесь): ${input.owns.join(', ')}.`);
  }
  if (input.notes) lines.push(`Заметки разбора:\n${input.notes}`);
  return lines;
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
  const where = input.branch ? ` в ветке ${input.branch}` : '';
  return [
    `План работы для группы «${input.title}»${where}.`,
    'Это подготовка ПЕРЕД работой: работу сделает отдельный прогон' +
      (input.workModel ? ` на модели ${input.workModel}` : '') +
      ', твоего контекста у него не будет — он получит задание и твой план, и больше ничего.',
    'НИЧЕГО НЕ ПРАВЬ: читай код, ищи, запускай проверки на чтение. Правки — не твоё звено.',
    '',
    'Задание группы:',
    input.task,
    '',
    ...boundaries(input),
    input.kind ? `Класс работы по мнению панели: ${input.kind}.` : '',
    '',
    'Составь план так, чтобы по нему можно было работать, не видя этого разговора:',
    '1. Разбор кода под задачу: какие модули задеты, как они устроены, где вход и выход.',
    '2. Эталоны в репозитории: как здесь уже делают похожее (файлы, паттерны) — работа копирует их, а не изобретает.',
    '3. Не меньше двух подходов с сильными и слабыми сторонами и выбор сильного с обоснованием.',
    '4. Шаги по порядку, каждый с файлами, которые он трогает, и проверкой после него (команда или что посмотреть).',
    '5. Критерии приёмки — по чему считать сделанным.',
    '6. «Не трогать»: границы из разбора и всё, что нашёл сам.',
    '7. Открытые вопросы, если остались, — с твоим рекомендуемым ответом.',
    '',
    `Закончи ответ РОВНО ОДНИМ блоком кода с языком ${PLAN_BLOCK_LANG}, внутри — план в markdown, ` +
      `не длиннее ${Math.round(PLAN_MAX_CHARS / 1000)} тысяч знаков. Внутри плана тройные кавычки не используй ` +
      '(команды — одинарными). После блока — ничего.',
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
    input.task,
    '',
    ...boundaries(input),
    '',
    input.plan
      ? 'План составлен заранее моделью-потолком в этой же копии — следуй ему по шагам, с проверкой ' +
        'после каждого. Отклоняйся, только если код говорит иначе, и назови отклонение в ответе.\n\n' +
        `План:\n${input.plan}`
      : 'План этой группы панель не получила (прогон плана не дал блока или не завершился) — ' +
        'спланируй сам: сначала разбор кода и эталоны, потом шаги с проверкой после каждого.',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
