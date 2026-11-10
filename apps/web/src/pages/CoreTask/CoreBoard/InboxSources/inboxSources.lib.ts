import type { ConfigView, CoreConfig } from '@agentdeck/contracts/core/config';
import {
  INBOX_DEFAULTS,
  inboxSourceSchema,
  type InboxSection,
  type InboxSource,
  type InboxSystem,
} from '@agentdeck/contracts/core/inbox';
import type { InboxDraft, SourceDraft, SourceField, SourceProblem } from './inboxSources.types';

/**
 * Окно «Источники входящих» (этап 12, I7, D16, D28): раздел `inbox` настройки ядра ↔ черновик окна.
 * Раздел пишет только `POST /v1/config` человека (строгий суд); черновик живёт в окне, и запись
 * собирает раздел из него целиком. Новый источник никогда не ставит записи в очередь сам —
 * «Сам в очередь» включает только человек (P183).
 */

/** Имя источника — та же форма, что у схемы ядра (`inboxSourceSchema.id`). */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Частоты опроса в окне, минуты; чаще минуты трекер не спрашивают (схема ядра). */
export const POLL_MINUTES = [1, 5, 15, 30, 60] as const;

const DEFAULT_POLL_MINUTES = INBOX_DEFAULTS.pollMs / 60_000;

let keySeq = 0;
const nextKey = () => `src-${++keySeq}`;

const listText = (list: readonly string[] | undefined) => (list ?? []).join(', ');

/** Список из текста через запятую: пробелы по краям срезаны, пустые и повторы выброшены. */
export function listOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const value = raw.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Строки репозиториев из записи: «путь на форже = локальная папка». */
export function reposText(repos: Record<string, string>): string {
  return Object.entries(repos)
    .map(([forge, local]) => `${forge} = ${local}`)
    .join('\n');
}

/**
 * Репозитории из текста: строка на проект, делитель — первый «=» (в локальном пути «=» бывает,
 * в пути проекта на форже — нет). Пустые строки пропущены; строка без пути с обеих сторон — ошибка.
 */
export function reposOf(text: string): { repos: Record<string, string>; bad: string[] } {
  const repos: Record<string, string> = {};
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    const forge = at > 0 ? line.slice(0, at).trim() : '';
    const local = at > 0 ? line.slice(at + 1).trim() : '';
    if (!forge || !local) bad.push(line);
    else repos[forge] = local;
  }
  return { repos, bad };
}

function sourceDraftOf(source: InboxSource): SourceDraft {
  const common = {
    key: nextKey(),
    id: source.id,
    system: source.system,
    enabled: source.enabled,
    autoQueue: source.autoQueue ?? false,
    repos: reposText(source.repos),
    bugLabels: listText(source.bugLabels),
  };
  if (source.system === 'jira') {
    return {
      ...common,
      labels: listText(source.jira.labels),
      assignedToMe: source.jira.assignedToMe,
      jql: source.jira.jql ?? '',
      reviewerMrs: false,
      ownMrsWithThreads: false,
    };
  }
  return {
    ...common,
    labels: listText(source.gitlab.issues.labels),
    assignedToMe: source.gitlab.issues.assignedToMe,
    jql: '',
    reviewerMrs: source.gitlab.reviewerMrs,
    ownMrsWithThreads: source.gitlab.ownMrsWithThreads,
  };
}

/** Черновик окна из действующего раздела; раздела нет — умолчания ядра (`INBOX_DEFAULTS`). */
export function draftOf(section: InboxSection | undefined): InboxDraft {
  return {
    sources: (section?.sources ?? []).map(sourceDraftOf),
    pollMinutes: (section?.pollMs ?? INBOX_DEFAULTS.pollMs) / 60_000,
    commentBack: section?.commentBack ?? INBOX_DEFAULTS.commentBack,
  };
}

/** Свободное имя для нового источника: имя системы, занято — с номером (`jira-2`, `jira-3`…). */
export function freeIdOf(system: InboxSystem, taken: readonly string[]): string {
  if (!taken.includes(system)) return system;
  let n = 2;
  while (taken.includes(`${system}-${n}`)) n += 1;
  return `${system}-${n}`;
}

/**
 * Новый источник: включён, но в очередь сам ничего не ставит (D28 — `autoQueue` по умолчанию
 * выключен), и ничего не читает, пока человек не назовёт метки, «назначенные на меня» или списки.
 */
export function newSourceDraft(system: InboxSystem, taken: readonly string[]): SourceDraft {
  return {
    key: nextKey(),
    id: freeIdOf(system, taken),
    system,
    enabled: true,
    autoQueue: false,
    labels: '',
    assignedToMe: false,
    jql: '',
    reviewerMrs: false,
    ownMrsWithThreads: false,
    repos: '',
    bugLabels: '',
  };
}

/** Читает ли источник хоть что-то: без меток, «назначенных», запроса и списков MR опрос пуст. */
function readsSomething(draft: SourceDraft): boolean {
  if (listOf(draft.labels).length > 0 || draft.assignedToMe) return true;
  if (draft.system === 'jira') return draft.jql.trim() !== '';
  return draft.reviewerMrs || draft.ownMrsWithThreads;
}

function sourceOf(draft: SourceDraft, repos: Record<string, string>): unknown {
  const bugLabels = listOf(draft.bugLabels);
  const common = {
    id: draft.id,
    enabled: draft.enabled,
    repos,
    ...(bugLabels.length > 0 ? { bugLabels } : {}),
    // Пишется всегда, и выключенным тоже: кто включил очередь, видно по записи настройки (P183).
    autoQueue: draft.autoQueue,
  };
  if (draft.system === 'jira') {
    const jql = draft.jql.trim();
    return {
      ...common,
      system: 'jira',
      jira: {
        labels: listOf(draft.labels),
        assignedToMe: draft.assignedToMe,
        ...(jql ? { jql } : {}),
      },
    };
  }
  return {
    ...common,
    system: 'gitlab',
    gitlab: {
      issues: { labels: listOf(draft.labels), assignedToMe: draft.assignedToMe },
      reviewerMrs: draft.reviewerMrs,
      ownMrsWithThreads: draft.ownMrsWithThreads,
    },
  };
}

/** Поле окна по пути ошибки схемы: первое узнанное имя с конца пути, иначе «значение». */
function fieldOf(path: readonly PropertyKey[]): SourceField {
  const names = path.filter((p): p is string => typeof p === 'string');
  if (names.includes('jql')) return 'jql';
  if (names.includes('bugLabels')) return 'bugLabels';
  if (names.includes('labels')) return 'labels';
  if (names.includes('repos')) return 'repos';
  return 'other';
}

/**
 * Отказ схемы ядра словами окна: какое поле и какой предел. Английская проза zod человеку не
 * показывается — до записи её видит только окно (поле длиннее предела, меток больше предела).
 */
function schemaProblemOf(
  id: string,
  issue:
    { code: string; path: readonly PropertyKey[]; maximum?: unknown; origin?: unknown } | undefined,
): SourceProblem {
  const field = fieldOf(issue?.path ?? []);
  if (issue?.code === 'too_big' && issue.maximum !== undefined) {
    const code = issue.origin === 'array' ? 'tooMany' : 'tooLong';
    return { code, values: { id, field, max: String(issue.maximum) } };
  }
  return { code: 'schema', values: { id, field } };
}

/**
 * Раздел `inbox` из черновика — или причины, почему его не записать: имя не той формы, занятое
 * имя, плохая строка репозитория, источник, который ничего не читает, и всё, что не прошло схему
 * ядра. Частота и ответ в тикет по умолчанию не пишутся (умолчание — ядра).
 */
export function sectionOf(
  draft: InboxDraft,
): { ok: true; section: InboxSection } | { ok: false; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const sources: InboxSource[] = [];
  const seen = new Set<string>();
  for (const row of draft.sources) {
    if (!SOURCE_ID.test(row.id)) {
      problems.push({ code: 'id', values: { id: row.id } });
      continue;
    }
    if (seen.has(row.id)) problems.push({ code: 'duplicate', values: { id: row.id } });
    seen.add(row.id);
    const { repos, bad } = reposOf(row.repos);
    for (const line of bad) problems.push({ code: 'repos', values: { line } });
    if (!readsSomething(row)) problems.push({ code: 'empty', values: { id: row.id } });
    const parsed = inboxSourceSchema.safeParse(sourceOf(row, repos));
    if (parsed.success) sources.push(parsed.data);
    else problems.push(schemaProblemOf(row.id, parsed.error.issues[0]));
  }
  if (problems.length > 0) return { ok: false, problems };
  const pollMs = Math.round(draft.pollMinutes * 60_000);
  return {
    ok: true,
    section: {
      ...(draft.pollMinutes !== DEFAULT_POLL_MINUTES ? { pollMs } : {}),
      sources,
      ...(draft.commentBack ? { commentBack: true } : {}),
    },
  };
}

/**
 * Документ записи: действующая настройка, от которой открыто окно, с новым разделом `inbox`, и её
 * отпечаток. Прочие разделы — как были: правка входящих не трогает чужого. Отпечаток устарел
 * (настройку записали мимо окна) — ядро ответит 409, и окно предложит перечитать, а не перетрёт.
 */
export function withInbox(
  view: ConfigView,
  section: InboxSection,
): { doc: CoreConfig; baseDigest: string } {
  return { doc: { ...view.doc, inbox: section }, baseDigest: view.digest };
}

/** Варианты частоты: список окна и действующее значение, если человек ставил иное. */
export function pollChoices(current: number): number[] {
  const list: number[] = [...POLL_MINUTES];
  if (!list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}
