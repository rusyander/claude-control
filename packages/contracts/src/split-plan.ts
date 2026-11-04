import { blockLangPattern } from './brand.ts';
import { labelledCut, OWNER_TEXT_MAX } from './quality-floor.ts';
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
 *
 * Разбор и план перед работой уехали в ядро (шаг `intake`, этап 10 ядра,
 * 02.11.2026), их задания панель больше не шлёт, как и задания работы после
 * плана и поднятой работы. Здесь осталось чтение блоков — лента показывает их
 * в старых разговорах.
 */

/** Потолки разбора: всё сверх них — не план, а простыня. */
const MAX_GROUPS = SPLIT_MAX_GROUPS;
const MAX_TASKS = 50;
/** Задача и заметки — текст владельца и разбора: режется только с меткой (`labelledCut`). */
const MAX_TASK = OWNER_TEXT_MAX;
const MAX_OWNS = 40;
const MAX_OWN = 200;
const MAX_NOTES = OWNER_TEXT_MAX;
const MAX_QUESTION = 600;
const MAX_CONFLICTS = 40;
const MAX_WHY = 400;
/**
 * План группы. Раньше 12k с молчаливой обрезкой: длинный план терял шаги и
 * критерии приёмки посреди слова, а работа считала его целым. Теперь потолок —
 * защита от мусора, и обрезка подписана.
 */
const PLAN_MAX_CHARS = OWNER_TEXT_MAX;

/** Что разбор сказал про одну группу. Индексы — с нуля, как в предложении. */
interface SplitPlanGroup {
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
interface SplitPlanConflict {
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
 * Ссылка на группу — номер (в промпте группы нумеровались С ЕДИНИЦЫ, модель так
 * и отвечает), числом или строкой `3` / `#3`. Предложения рядом с лентой нет,
 * поэтому годится любой номер в пределах разделения, а ссылка по названию
 * отбрасывается: сопоставить её не с чем. Не разобрано — `undefined`.
 */
function groupRef(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const index = value - 1;
    return index >= 0 && index < MAX_GROUPS ? index : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^#?\d+$/.test(trimmed) ? groupRef(Number(trimmed.replace('#', ''))) : undefined;
  }
  return undefined;
}

function refList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: number[] = [];
  for (const item of raw) {
    const index = groupRef(item);
    if (index !== undefined && !out.includes(index)) out.push(index);
  }
  return out;
}

/**
 * Разбор блока уровня 1 для показа в ленте. Терпим к форме (номер под разными
 * ключами, `hold` строкой или объектом с `question`), строг к смыслу: группа
 * без узнаваемого номера отбрасывается, а не привязывается наугад.
 */
function parseSplitPlan(raw: unknown): SplitPlan | undefined {
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
    const index = groupRef(group.index ?? group.group ?? group.id ?? group.n);
    if (index === undefined || groups.some((known) => known.index === index)) continue;

    const holdRaw = group.hold;
    const hold =
      typeof holdRaw === 'string'
        ? text(holdRaw, MAX_QUESTION)
        : holdRaw && typeof holdRaw === 'object'
          ? text((holdRaw as { question?: unknown }).question, MAX_QUESTION)
          : undefined;
    const notes = prose(group.notes ?? group.note, MAX_NOTES);

    groups.push({
      index,
      owns: list(group.owns ?? group.files, MAX_OWNS, MAX_OWN),
      tasks: list(group.tasks, MAX_TASKS, MAX_TASK, prose),
      ...(notes ? { notes } : {}),
      after: refList(group.after ?? group.dependsOn).filter((ref) => ref !== index),
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
    const resolvedBy = groupRef(conflict.resolvedBy ?? conflict.owner ?? conflict.group);
    if (paths.length === 0 || resolvedBy === undefined) continue;
    conflicts.push({
      paths,
      resolvedBy,
      why: text(conflict.why ?? conflict.reason, MAX_WHY) ?? '',
    });
  }

  return { groups, conflicts, order: refList(source.order) };
}

/** Что осталось от ответа после вырезания блока и что из него разобрано. */
interface SplitPlanScan {
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
export function scanSplitPlanBlocks(source: string): SplitPlanScan {
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
    const parsed = parseSplitPlan(body);
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
interface PlanScan {
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
