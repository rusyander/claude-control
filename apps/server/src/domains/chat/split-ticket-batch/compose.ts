import { createHash } from 'node:crypto';
import {
  sideLabels,
  ticketSide,
  type SplitTicketBundle,
  type SplitTicketCluster,
  type TicketArea,
  type TicketProblemDetail,
  type TicketSeverity,
  type TicketSide,
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
    priority: (value: string, name: string) => `Серьёзность: ${value} → приоритет Jira «${name}»`,
    side: 'Сторона',
    sides: {
      frontend: 'FRONTEND — фронтенд',
      backend: 'BACKEND — бэкенд',
      fullstack: 'FULLSTACK — фронтенд и бэкенд',
      other: 'ДРУГОЕ — не фронтенд и не бэкенд',
    },
    context: 'Контекст',
    provenance: (groups: string) => `Группы разделения нашли это вне своих задач: ${groups}.`,
    fix: 'Что сделать',
    fixOne: (title: string) => `Устранить дефект «${title}»; место и доказательства — ниже.`,
    fixMany: (count: number) =>
      `Устранить дефекты из раздела «Дефекты» (${count} шт.); у каждого своё место и доказательства.`,
    acceptance: 'Критерии приёмки',
    gone: (title: string) => `«${title}» больше не воспроизводится`,
    code: 'Где в коде',
    defects: 'Дефекты',
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
    priority: (value: string, name: string) => `Severity: ${value} → Jira priority «${name}»`,
    side: 'Side',
    sides: {
      frontend: 'FRONTEND',
      backend: 'BACKEND',
      fullstack: 'FULLSTACK — frontend and backend',
      other: 'OTHER — neither frontend nor backend',
    },
    context: 'Context',
    provenance: (groups: string) => `Split groups found this outside their own tasks: ${groups}.`,
    fix: 'What to do',
    fixOne: (title: string) => `Fix the defect «${title}»; place and evidence are below.`,
    fixMany: (count: number) =>
      `Fix the defects listed under «Defects» (${count}); each has its own place and evidence.`,
    acceptance: 'Acceptance criteria',
    gone: (title: string) => `«${title}» no longer reproduces`,
    code: 'Where in the code',
    defects: 'Defects',
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
 * Отпечаток находки: по нему следующий «Опубликовать» узнаёт открытую задачу
 * про ту же находку, даже если её название с тех пор правили. Живёт в памяти
 * панели (`prints.ts`), в трекер не пишется (владелец 26.10.2026: хэш-подобных
 * id в Jira нет никогда).
 */
export const FINGERPRINT_PREFIX = 'agentdeck-fp:';

export function fingerprintOf(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * Отпечатки из строки `agentdeck-fp:` задач, заведённых до 26.10.2026, —
 * только чтение для сверки; новой такой строки панель не пишет.
 */
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

export interface ComposedIssue {
  summary: string;
  clusters: readonly SplitTicketCluster[];
  details: ProblemDetails;
  fix?: string;
  acceptance?: readonly string[];
}

/** Что о задаче видно сразу, первой строкой описания: сторона и срочность. */
export interface IssueMeta {
  side: TicketSide;
  severity: TicketSeverity;
  /** Приоритет Jira, на который легла серьёзность; нет — «приоритета с таким именем нет». */
  priority?: string;
}

/** Шапка описания: «Сторона: FRONTEND» и серьёзность с приоритетом. */
export function issueHeader(meta: IssueMeta, lang: TicketLang): string {
  const label = LABELS[lang];
  return [
    `${label.side}: ${label.sides[meta.side]}`,
    meta.priority ? label.priority(meta.severity, meta.priority) : label.severity(meta.severity),
  ].join('\n');
}

/** «Где в коде»: каждое место находок задачи один раз, повторы тоже. */
function codePlaces(clusters: readonly SplitTicketCluster[]): string[] {
  const places = clusters.flatMap((cluster) =>
    cluster.tickets.map((ticket) => ticket.where.trim()),
  );
  return [...new Set(places.filter(Boolean))];
}

/** Критерии приёмки: модели, иначе по дефекту — ожидаемое модели или «не воспроизводится». */
function acceptanceOf(issue: ComposedIssue, lang: TicketLang): string[] {
  if (issue.acceptance && issue.acceptance.length > 0) return [...issue.acceptance];
  return issue.clusters.flatMap((cluster) => {
    const title = cluster.tickets[0]?.title;
    if (!title) return [];
    const expected = issue.details.get(cluster.id)?.expected;
    return [expected ? `«${title}»: ${expected}` : LABELS[lang].gone(title)];
  });
}

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n');

/**
 * Описание новой задачи (владелец 25.10.2026): шапка (сторона, серьёзность и
 * приоритет), контекст, что сделать, критерии приёмки, где в коде, разделы
 * дефектов. Чего модель не дала, сервер пишет из самих находок — пустого
 * раздела в задаче нет. Отпечатков находок в тексте нет: они в памяти панели.
 */
export function issueDescription(issue: ComposedIssue, lang: TicketLang, meta?: IssueMeta): string {
  const label = LABELS[lang];
  const groups = [
    ...new Set(issue.clusters.flatMap((cluster) => cluster.tickets.flatMap((t) => t.groups))),
  ];
  const head = issue.clusters[0]?.tickets[0]?.title ?? '';
  const fix =
    issue.fix ||
    (issue.clusters.length > 1 ? label.fixMany(issue.clusters.length) : label.fixOne(head));
  const places = codePlaces(issue.clusters);
  return [
    meta ? issueHeader(meta, lang) : '',
    `${label.context}: ${issue.summary || label.provenance(groups.join(', '))}`,
    `${label.fix}: ${fix}`,
    `${label.acceptance}:\n${bullets(acceptanceOf(issue, lang))}`,
    places.length > 0 ? `${label.code}:\n${bullets(places)}` : '',
    `${label.defects}:\n${problemSections(issue.clusters, issue.details, lang)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Комментарий в уже открытую задачу про то же: те же разделы новых находок. */
export function commentBody(issue: ComposedIssue, lang: TicketLang): string {
  return [LABELS[lang].again, problemSections(issue.clusters, issue.details, lang)].join('\n\n');
}

/**
 * Метки задачи: сторона первой (её видно в списке Jira), области модели, общая
 * метка панели и серьёзность без подходящего приоритета. Внутренних машинных
 * меток (хэш родителя, id чата, короткий sha) здесь нет (владелец 26.10.2026):
 * им место только в наших инструментах, не в трекере.
 */
export function issueLabels(input: {
  side: TicketSide;
  area: readonly TicketArea[];
  base: string;
  unmappedSeverity?: TicketSeverity;
}): string[] {
  return [
    ...new Set([
      ...sideLabels(input.side),
      ...input.area,
      input.base,
      ...(input.unmappedSeverity ? [`severity-${input.unmappedSeverity}`] : []),
    ]),
  ];
}

/** Сторона задачи по местам её находок и области модели. */
export function draftSide(
  clusters: readonly SplitTicketCluster[],
  area: readonly string[],
): TicketSide {
  return ticketSide(
    clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.where)),
    area,
  );
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
