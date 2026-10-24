import { array, object, string, unknown, type infer as Infer } from 'zod';
import { splitTicketKey, type SplitTicketView } from './split-tickets.ts';
import {
  NEAR_DUPLICATE_RATIO,
  nearDuplicate,
  normTitle,
  SAME_FILE_RATIO,
  whereFiles,
} from './split-ticket-text.ts';

export { nearDuplicate, titleOverlap, whereFiles } from './split-ticket-text.ts';

/**
 * «Разобрать…» в хабе (владелец 24.10.2026): предложенные группами тикеты разом.
 *
 * Группы пишут один и тот же дефект по нескольку раз — каждая своими словами, —
 * и десять строк списка на деле оказываются тремя задачами. Отсюда два пути:
 * «Опубликовать в Jira» (модель сводит повторы в задачи, сервер их заводит) и
 * «Решить здесь» (один новый чат проекта с задачей из тех же находок).
 *
 * Здесь — общее для сервера и панели: какие находки ещё открыты, детерминированная
 * склейка явных повторов (до модели и без неё) и форма данных, которую модель
 * обязана вернуть. Ответ модели — ДАННЫЕ: схема ниже лишнее отбрасывает, а
 * ссылки на находки сверяет вызывающий с записью.
 */

/** Области задачи — метки Jira. Список закрыт: модель не придумывает своих. */
export const TICKET_AREAS = ['backend', 'frontend', 'infra', 'tooling', 'docs', 'tests'] as const;
export type TicketArea = (typeof TICKET_AREAS)[number];

/** Серьёзность — на приоритет Jira по имени; не нашлось — меткой `severity-<x>`. */
export const TICKET_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];

/** Метка каждой задачи, заведённой из хаба: по ней их находят в трекере. */
export const TICKET_BATCH_LABEL = 'agentdeck-proposal';

/** Открытая находка: ещё не заведена и не взята в чат; с группами, которые на неё наткнулись. */
export interface OpenSplitTicket {
  key: string;
  title: string;
  where: string;
  why: string;
  groups: string[];
}

interface TicketGroupLike {
  title: string;
  tickets?: SplitTicketView[];
}

/**
 * Открытые находки всех групп одним списком: повтор по `splitTicketKey` — одна
 * строка с обеими группами. Заведённая или взятая хоть в одной группе — не
 * открыта нигде: отметка ложится на все группы сразу.
 */
export function openSplitTickets(groups: readonly TicketGroupLike[]): OpenSplitTicket[] {
  const byKey = new Map<string, OpenSplitTicket>();
  const closed = new Set<string>();
  for (const group of groups) {
    for (const ticket of group.tickets ?? []) {
      const key = splitTicketKey(ticket);
      if (ticket.filed || ticket.taken) closed.add(key);
      const known = byKey.get(key);
      if (known) {
        if (!known.groups.includes(group.title)) known.groups.push(group.title);
        continue;
      }
      byKey.set(key, {
        key,
        title: ticket.title,
        where: ticket.where,
        why: ticket.why,
        groups: [group.title],
      });
    }
  }
  return [...byKey.values()].filter((ticket) => !closed.has(ticket.key));
}

/** Склейка явных повторов: одна или несколько находок, которые точно один дефект. */
export interface SplitTicketCluster {
  /** `C1`, `C2`, … — по нему модель ссылается на склейку; ключи находок ей не нужны. */
  id: string;
  tickets: OpenSplitTicket[];
}

/** Место без регистра и пробелов; короче шести знаков — не место, а слово («web»), не склеивает. */
function normWhere(value: string): string {
  const flat = value.toLowerCase().replace(/\s+/g, '').trim();
  return flat.length >= 6 ? flat : '';
}

/** Связность «это одно и то же» по номерам: union-find, корень — меньший номер. */
function unionFind(size: number) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at] ?? at;
    return at;
  };
  const join = (a: number, b: number): void => {
    const [ra, rb] = [root(a), root(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  /** Классы в порядке первого появления, внутри — в порядке входа. */
  const classes = (): number[][] => {
    const byRoot = new Map<number, number[]>();
    for (let index = 0; index < size; index += 1) {
      const at = root(index);
      byRoot.set(at, [...(byRoot.get(at) ?? []), index]);
    }
    return [...byRoot.values()];
  };
  return { join, classes };
}

/**
 * Детерминированная склейка повторов — один дефект, без модели:
 * - одинаковое название (без регистра и знаков) или одинаковое конкретное место;
 * - «то же другими словами»: близкие названия (`nearDuplicate`);
 * - один файл и заметно похожие названия (`SAME_FILE_RATIO`) — тот же симптом там же.
 * Один файл при разных словах — НЕ повтор (два дефекта в одном модуле), их
 * сводит в одну задачу `bundleSplitTickets`, не склейка. Связность транзитивная;
 * порядок — порядок первого появления.
 */
export function clusterSplitTickets(tickets: readonly OpenSplitTicket[]): SplitTicketCluster[] {
  const sets = unionFind(tickets.length);
  const firstBy = new Map<string, number>();
  tickets.forEach((ticket, index) => {
    for (const mark of [`t:${normTitle(ticket.title)}`, `w:${normWhere(ticket.where)}`]) {
      if (mark === 't:' || mark === 'w:') continue;
      const seen = firstBy.get(mark);
      if (seen === undefined) firstBy.set(mark, index);
      else sets.join(seen, index);
    }
  });
  const files = tickets.map((ticket) => new Set(whereFiles(ticket.where)));
  for (let a = 0; a < tickets.length; a += 1) {
    for (let b = a + 1; b < tickets.length; b += 1) {
      const [left, right] = [tickets[a]!, tickets[b]!];
      const sameFile = [...files[a]!].some((path) => files[b]!.has(path));
      const ratio = sameFile ? SAME_FILE_RATIO : NEAR_DUPLICATE_RATIO;
      if (nearDuplicate(left.title, right.title, ratio)) sets.join(a, b);
    }
  }
  return sets.classes().map((members, index) => ({
    id: `C${index + 1}`,
    tickets: members.map((member) => tickets[member]!),
  }));
}

/**
 * Связанные дефекты — одна задача трекера (ревизия 3): разные дефекты одного
 * файла чинит один человек одним MR, и десять задач по одному модулю — шум.
 * Связь — общий файл в «где»; дефект без файла — своя задача. Модель может
 * свести связки дальше, но разделить связку не может: она ссылается на связку
 * целиком.
 */
export interface SplitTicketBundle {
  /** `B1`, `B2`, … — по нему модель ссылается на связку. */
  id: string;
  clusters: SplitTicketCluster[];
  /** Общие файлы связки — для окна («одна задача: общий файл …»). */
  files: string[];
}

/** Больше дефектов в одной задаче — уже не задача, а свалка: дальше новая связка. */
export const MAX_BUNDLE_DEFECTS = 6;

export function bundleSplitTickets(clusters: readonly SplitTicketCluster[]): SplitTicketBundle[] {
  const sets = unionFind(clusters.length);
  const files = clusters.map(
    (cluster) => new Set(cluster.tickets.flatMap((ticket) => whereFiles(ticket.where))),
  );
  const firstBy = new Map<string, number>();
  files.forEach((own, index) => {
    for (const path of own) {
      const seen = firstBy.get(path);
      if (seen === undefined) firstBy.set(path, index);
      else sets.join(seen, index);
    }
  });
  const bundles: SplitTicketCluster[][] = [];
  for (const members of sets.classes()) {
    for (let at = 0; at < members.length; at += MAX_BUNDLE_DEFECTS) {
      bundles.push(members.slice(at, at + MAX_BUNDLE_DEFECTS).map((member) => clusters[member]!));
    }
  }
  return bundles.map((own, index) => {
    const counted = new Map<string, number>();
    for (const cluster of own) {
      const paths = new Set(cluster.tickets.flatMap((ticket) => whereFiles(ticket.where)));
      for (const path of paths) counted.set(path, (counted.get(path) ?? 0) + 1);
    }
    const shared = own.length > 1 ? [...counted].filter(([, count]) => count > 1) : [];
    return { id: `B${index + 1}`, clusters: own, files: shared.map(([path]) => path) };
  });
}

const isArea = (value: string): value is TicketArea =>
  (TICKET_AREAS as readonly string[]).includes(value);
const isSeverity = (value: string): value is TicketSeverity =>
  (TICKET_SEVERITIES as readonly string[]).includes(value);

/**
 * Ответ модели на «сведи находки в задачи» — внешняя оболочка. Задачи внутри
 * разбираются по одной (`ticketBatchIssueSchema`): одна кривая задача не
 * роняет остальные, её склейки уходят отдельными задачами без модели.
 */
export const ticketBatchModelSchema = object({ issues: array(unknown()).max(50) });

/**
 * Одна задача ответа модели. Незнакомые поля zod отбрасывает; область вне
 * списка выпадает, серьёзность вне списка — пусто; ссылки `sources` сверяет
 * сервер с записью (придуманная моделью — не находка).
 */
/**
 * Подробности одного дефекта от модели — только то, чего в находке нет: шаги,
 * ожидалось, на деле. Не знает — пусто; сервер пустое не выводит и не выдумывает.
 */
const problemDetailSchema = object({
  id: string().trim().min(1).max(20),
  repro: string().trim().max(1500).default(''),
  expected: string().trim().max(1000).default(''),
  actual: string().trim().max(1000).default(''),
});
export type TicketProblemDetail = Infer<typeof problemDetailSchema>;

export const ticketBatchIssueSchema = object({
  title: string().trim().min(1).max(200),
  /** Короткое введение над разделами дефектов; разделы собирает сервер. */
  summary: string().trim().max(1500).default(''),
  /** Подробности по дефектам (`C…`); кривая запись выпадает одна, не роняя задачу. */
  problems: array(unknown())
    .max(50)
    .default([])
    .transform((list) =>
      list.flatMap((item) => {
        const parsed = problemDetailSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  area: array(string())
    .max(20)
    .default([])
    .transform((list) =>
      [...new Set(list.map((item) => item.trim().toLowerCase()))].filter(isArea),
    ),
  severity: string()
    .optional()
    .transform((value) => {
      const norm = value?.trim().toLowerCase() ?? '';
      return isSeverity(norm) ? norm : undefined;
    }),
  sources: array(string().trim().min(1)).min(1).max(50),
});
export type TicketBatchModelIssue = Infer<typeof ticketBatchIssueSchema>;

/** Куда заводить: подключённая Jira и её проекты — для окна «Разобрать…». */
export interface SplitTicketTarget {
  /** Jira подключена (включена и есть ключ). Нет — «Опубликовать» выключено. */
  connected: boolean;
  /** Адрес сайта Jira из интеграции; только для показа. */
  site?: string;
  projects: { key: string; name: string }[];
  /** Проект по умолчанию: привязка проекта, иначе последний выбранный, иначе первый. */
  projectKey?: string;
  /** Откуда взят проект по умолчанию — окно говорит это словами. */
  projectFrom?: 'bound' | 'last' | 'first';
  issueTypes: string[];
  /** Bug, если есть; иначе Task; иначе первый. */
  issueType?: string;
  /** Чтение Jira не удалось: код текста для окна. */
  messageCode?: string;
  params?: Record<string, string | number>;
}

/** Тело «Опубликовать в Jira». */
export interface SplitTicketPublishBody {
  projectKey: string;
  issueType: string;
  /** Язык описаний задач — язык интерфейса человека. */
  lang?: 'ru' | 'en';
  /** Повторить только упавшие задачи прошлой публикации (без нового прохода модели). */
  retryFailed?: boolean;
}

/** Заведённая (или найденная заведённой) задача. */
export interface SplitTicketPublishedIssue {
  key: string;
  url: string;
  title: string;
  /** Ключи находок, которые задача собрала. */
  proposals: string[];
  /** false — задачу уже завёл другой запрос (двойной клик, вторая вкладка) или она уже была открыта. */
  created: boolean;
  /**
   * Открытая задача трекера про то же уже была — находки ушли в неё
   * комментарием, копии нет (ревизия 3).
   */
  commented?: boolean;
  /** Дефекты задачи: название и повторы, сведённые в него, — что именно склеено. */
  defects: { title: string; duplicates: string[] }[];
}

/** Задача, которую завести не вышло: причина и находки — они остаются открытыми. */
export interface SplitTicketPublishFailure {
  title: string;
  proposals: string[];
  message: string;
  messageCode?: string;
  params?: Record<string, string | number>;
}

export interface SplitTicketPublished {
  issues: SplitTicketPublishedIssue[];
  failed: SplitTicketPublishFailure[];
  /** `model` — задачи свела модель; `fallback` — модель недоступна, по склейке на задачу. */
  mode: 'model' | 'fallback';
}

/** Ответ «Решить здесь»: новый чат и сколько находок в него ушло. */
export interface SplitTicketTaken {
  chatId: string;
  count: number;
}
