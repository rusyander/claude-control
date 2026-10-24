import { createHash } from 'node:crypto';
import type {
  SplitTicketBundle,
  SplitTicketCluster,
  TicketArea,
  TicketProblemDetail,
  TicketSeverity,
} from '@agentdeck/contracts/split-ticket-batch';

/**
 * Тексты, которые уходят в трекер и в новый чат: описание задачи, комментарий
 * в уже открытую задачу и задание «Решить здесь». Их читает человек — в Jira и
 * в ленте чата, — поэтому на языке его интерфейса, а не на английском модельного
 * промпта.
 *
 * Описание собирает СЕРВЕР, раздел на дефект (ревизия 3): что, где, доказательства,
 * шаги, ожидалось / на деле, кто нашёл, повторы. От модели — только введение и
 * подробности, которых в находке нет; без модели разделы те же, без подробностей.
 * Слабая или чужая модель структуру не сломает: её текст — поле внутри раздела.
 */
export type TicketLang = 'ru' | 'en';

const LABELS = {
  ru: {
    where: 'Где',
    evidence: 'Доказательства',
    repro: 'Шаги',
    expected: 'Ожидалось',
    actual: 'На деле',
    foundBy: 'Нашли группы',
    sameAs: 'То же другими словами',
    severity: (value: string) => `Серьёзность: ${value} (приоритета с таким именем в Jira нет)`,
    again: 'Группы разделения снова нашли то, о чём эта задача; копию панель не завела:',
    task:
      'Исправь отдельной задачей дефекты, которые группы разделения нашли вне своих задач ' +
      '(повторы уже сведены, связанные дефекты собраны в задачи по общему месту). ' +
      'Работай по правилам проекта: проверки, ветка, MR — как обычно. ' +
      'Если задачи расходятся по разным местам, можешь предложить разделение на группы.',
    taskHead: (index: number, files: string) => `Задача ${index}${files ? ` (${files})` : ''}`,
  },
  en: {
    where: 'Where',
    evidence: 'Evidence',
    repro: 'Steps',
    expected: 'Expected',
    actual: 'Actual',
    foundBy: 'Found by groups',
    sameAs: 'Same defect in other words',
    severity: (value: string) => `Severity: ${value} (Jira has no priority with this name)`,
    again: 'The split groups found this again; the panel did not file a copy:',
    task:
      'Fix, as a separate task, the defects the split groups found outside their own tasks ' +
      '(duplicates are already merged, related defects are grouped into tasks by shared place). ' +
      'Follow the project rules: checks, branch, merge request as usual. ' +
      'If the tasks live in unrelated places, you may propose splitting them into groups.',
    taskHead: (index: number, files: string) => `Task ${index}${files ? ` (${files})` : ''}`,
  },
} as const;

/** Подробности модели по дефекту (`C…`); нет — раздел без них. */
export type ProblemDetails = ReadonlyMap<string, TicketProblemDetail>;

/**
 * Отпечаток находки в тексте задачи: по нему следующий «Опубликовать» узнаёт
 * открытую задачу про ту же находку, даже если её название с тех пор правили.
 * Хэш, а не сам ключ: ключ — название и место, в трекере он лишний шум.
 */
export const FINGERPRINT_PREFIX = 'agentdeck-fp:';

export function fingerprintOf(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function fingerprintLine(keys: readonly string[]): string {
  return `${FINGERPRINT_PREFIX} ${[...new Set(keys.map(fingerprintOf))].join(' ')}`;
}

/** Отпечатки, записанные в тексте задачи (описание или комментарий). */
export function fingerprintsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const line of text.matchAll(/agentdeck-fp:\s*([0-9a-f ]+)/g)) {
    for (const print of (line[1] ?? '').split(/\s+/)) if (print) found.add(print);
  }
  return found;
}

/** Раздел одного дефекта: строки с меткой, пустое не выводится. */
function problemSection(
  cluster: SplitTicketCluster,
  index: number,
  details: ProblemDetails,
  lang: TicketLang,
): string {
  const label = LABELS[lang];
  const [head, ...rest] = cluster.tickets;
  if (!head) return '';
  const detail = details.get(cluster.id);
  const groups = [...new Set(cluster.tickets.flatMap((ticket) => ticket.groups))];
  const line = (name: string, value: string | undefined) => (value ? `${name}: ${value}` : '');
  return [
    `${index}. ${head.title}`,
    line(label.where, head.where),
    line(label.evidence, head.why),
    line(label.repro, detail?.repro),
    line(label.expected, detail?.expected),
    line(label.actual, detail?.actual),
    line(label.foundBy, groups.join(', ')),
    ...rest.map(
      (ticket) => `${label.sameAs}: «${ticket.title}»${ticket.where ? ` (${ticket.where})` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Разделы всех дефектов задачи, по номеру на дефект. */
export function problemSections(
  clusters: readonly SplitTicketCluster[],
  details: ProblemDetails,
  lang: TicketLang,
): string {
  return clusters
    .map((cluster, index) => problemSection(cluster, index + 1, details, lang))
    .filter(Boolean)
    .join('\n\n');
}

const keysOf = (clusters: readonly SplitTicketCluster[]): string[] =>
  clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.key));

export interface ComposedIssue {
  summary: string;
  clusters: readonly SplitTicketCluster[];
  details: ProblemDetails;
}

/**
 * Описание новой задачи: введение модели (если есть), разделы дефектов,
 * серьёзность без подходящего приоритета и строка отпечатков находок.
 */
export function issueDescription(
  issue: ComposedIssue,
  lang: TicketLang,
  unmappedSeverity?: TicketSeverity,
): string {
  return [
    issue.summary,
    problemSections(issue.clusters, issue.details, lang),
    unmappedSeverity ? LABELS[lang].severity(unmappedSeverity) : '',
    fingerprintLine(keysOf(issue.clusters)),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Комментарий в уже открытую задачу про то же: те же разделы и отпечатки новых находок. */
export function commentBody(issue: ComposedIssue, lang: TicketLang): string {
  return [
    LABELS[lang].again,
    problemSections(issue.clusters, issue.details, lang),
    fingerprintLine(keysOf(issue.clusters)),
  ].join('\n\n');
}

/** Метки задачи: области и общая метка панели. */
export function issueLabels(
  area: readonly TicketArea[],
  base: string,
  unmappedSeverity?: TicketSeverity,
): string[] {
  return [...area, base, ...(unmappedSeverity ? [`severity-${unmappedSeverity}`] : [])];
}

/**
 * Первое сообщение чата «Решить здесь»: задание и задачи по связкам, в каждой —
 * разделы её дефектов. Повторы одного дефекта — строкой «то же другими словами»,
 * чтобы агент не чинил один дефект пять раз.
 */
export function takePrompt(bundles: readonly SplitTicketBundle[], lang: TicketLang): string {
  const label = LABELS[lang];
  const none: ProblemDetails = new Map();
  const items = bundles.map((bundle, index) =>
    [
      label.taskHead(index + 1, bundle.files.join(', ')),
      problemSections(bundle.clusters, none, lang),
    ].join('\n'),
  );
  return [label.task, ...items].join('\n\n');
}
