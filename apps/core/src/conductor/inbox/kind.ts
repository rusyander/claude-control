import { createHash } from 'node:crypto';
import type { BoardLaunch, BoardSource } from '@agentdeck/contracts/core/board';
import {
  INBOX_BUG_LABELS_DEFAULT,
  type InboxItem,
  type InboxSource,
} from '@agentdeck/contracts/core/inbox';
import { INTAKE_BODY_MAX } from '@agentdeck/contracts/core/intake';
import { REVIEW_LINK_PRESET } from '@agentdeck/contracts/core/review-link';
import { ANSWER_REVIEWERS_PRESET } from '../estimate/estimate.ts';

/**
 * Тип тикета → пресет и запуск записи доски (этап 12, D17, P164). Чистые функции: снимок тикета —
 * данные, ни одно слово его текста не меняет ни пресет, ни запуск, ни очередь (P133): решают
 * только вид (`kind`), тип трекера и метки.
 *
 * - MR на моё ревью → `review-link` (ссылка на MR);
 * - мой MR с нерешёнными нитями → `answer-reviewers` (ссылка; запускатель открывает его своей
 *   дорогой `openAnswerTaskFromMr`);
 * - задача с типом Bug или меткой из `bugLabels` (нет — `['bug']`) → `bug-fix`;
 * - иначе → `tracker-ticket`.
 */

/** Пресет записи из Telegram (`/task <текст>`): ручная запись, ничего не известно, кроме текста. */
export const TELEGRAM_ENTRY_PRESET = 'feature';

/** Тикет, как его прочитал источник: строка поиска + тело и поля снимка (тело в строке нет). */
export interface InboxRead {
  item: InboxItem;
  /** Описание текстом; пусто — запрос собирается из заголовка и адреса. */
  body: string;
  /** Поля трекера как есть (статус, приоритет): данные, не команды. */
  fields?: Record<string, string>;
}

/** Черновик записи доски из тикета: что положить и, если старт заранее невозможен, — почему. */
export interface IntakeDraft {
  item: InboxItem;
  preset: string;
  source: BoardSource;
  launch: BoardLaunch;
  /** Старт заранее не пройдёт (нет локального репозитория) — причина на записи. */
  reason?: string;
}

const lower = (s: string): string => s.trim().toLowerCase();

/** Пресет по виду, типу и меткам (P164); тексты тикета не участвуют. */
export function presetOf(
  item: Pick<InboxItem, 'kind' | 'type' | 'labels'>,
  bugLabels: readonly string[] = INBOX_BUG_LABELS_DEFAULT,
): string {
  if (item.kind === 'review-mr') return REVIEW_LINK_PRESET;
  if (item.kind === 'own-mr') return ANSWER_REVIEWERS_PRESET;
  const bugs = new Set(bugLabels.map(lower));
  if (item.type !== undefined && lower(item.type) === 'bug') return 'bug-fix';
  if (item.labels.some((label) => bugs.has(lower(label)))) return 'bug-fix';
  return 'tracker-ticket';
}

/** Путь проекта форжа из ключа: `<проект>!<iid>` у MR, `<проект>#<iid>` у задачи форжа. */
export function forgeProjectOf(key: string): string {
  const cut = key.search(/[!#]\d+$/);
  return cut > 0 ? key.slice(0, cut) : key;
}

/** Ключ проекта Jira из ключа задачи: `PROJ-12` → `PROJ`. */
export function jiraProjectOf(key: string): string {
  const cut = key.lastIndexOf('-');
  return cut > 0 ? key.slice(0, cut) : key;
}

/**
 * Локальный репозиторий тикета по `repos` источника: GitLab — путь проекта, Jira — ключ проекта,
 * затем `*`. Нет записи — `undefined` (запись встанет с причиной, а не с догадкой).
 */
export function repoOf(source: InboxSource, item: Pick<InboxItem, 'key'>): string | undefined {
  if (source.system === 'gitlab') return source.repos[forgeProjectOf(item.key)];
  return source.repos[jiraProjectOf(item.key)] ?? source.repos['*'];
}

/** sha256 строки (hex). */
export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Пути, названные в описании (D26): `src/a/b.ts`, `apps/x/y.tsx` — токены с каталогом и
 * расширением. Факт текста, а не вывод модели; потолок — 200 путей.
 */
export function pathsIn(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /(?:^|[\s`'"(<[])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'")>\],:;!?])/g;
  for (const match of text.matchAll(re)) {
    const path = match[1]!.replace(/^\.\//, '');
    if (path.length <= 1000 && !path.includes('://')) out.add(path);
    if (out.size >= 200) break;
  }
  return [...out];
}

function noRepoReason(source: InboxSource, item: InboxItem): string {
  const project = source.system === 'gitlab' ? forgeProjectOf(item.key) : jiraProjectOf(item.key);
  return `no local repository for ${project}: add it to repos of inbox source ${source.id}`;
}

/** Черновик записи доски из прочитанного тикета (D17): пресет, источник, запуск. */
export function draftOf(source: InboxSource, read: InboxRead, fetchedAt: number): IntakeDraft {
  const { item } = read;
  const preset = presetOf(item, source.bugLabels);
  const boardSource: BoardSource = {
    kind: source.system === 'jira' ? 'tracker' : 'forge',
    system: source.id,
    key: item.key.slice(0, 200),
    url: item.url.slice(0, 2000),
    title: item.title.slice(0, 500),
  };
  const repo = repoOf(source, item);
  const reason = repo ? undefined : noRepoReason(source, item);
  if (item.kind !== 'issue') {
    return {
      item,
      preset,
      source: boardSource,
      launch: { kind: 'link', mrUrl: item.url, ...(repo ? { repo } : {}) },
      ...(reason ? { reason } : {}),
    };
  }
  const body = read.body.slice(0, INTAKE_BODY_MAX);
  const request = (body.trim() ? body : `${item.title}\n${item.url}`).slice(0, 64_000);
  const fields: Record<string, string | string[]> = {
    ...(read.fields ?? {}),
    ...(item.type ? { type: item.type } : {}),
    labels: item.labels,
  };
  const intake = {
    kind: 'tracker',
    key: item.key.slice(0, 200),
    title: item.title.slice(0, 300),
    body,
    fields,
    links: [{ url: item.url.slice(0, 2000) }],
    fetchedAt,
    digest: item.digest,
  };
  return {
    item,
    preset,
    source: boardSource,
    launch: {
      kind: 'fields',
      fields: {
        title: item.title.slice(0, 300),
        request,
        ...(repo ? { repos: [{ path: repo, baseRef: null }] } : {}),
        source: intake,
      },
    },
    ...(reason ? { reason } : {}),
  };
}

/**
 * Запись рукой из Telegram (D29, P193): источник `telegram`, ключ `tg:<чат>:<сообщение>`, пресет
 * «фича». Запуск — текст и репозитории настройки человека `telegram.repos` (W2-D): с ними запись
 * стартует ходом «В работу»; без них репозиторий человек выберет на доске. Никогда не в очередь сама.
 */
export function telegramDraft(
  text: string,
  key: string,
  repos?: readonly { path: string; baseRef: string | null }[],
): Omit<IntakeDraft, 'item'> {
  const title = (text.split('\n').find((l) => l.trim()) ?? text).trim().slice(0, 300);
  const fields: Extract<BoardLaunch, { kind: 'fields' }>['fields'] = {
    title,
    request: text.slice(0, 64_000),
  };
  if (repos && repos.length > 0)
    fields.repos = repos.map((r) => ({ path: r.path, baseRef: r.baseRef }));
  return {
    preset: TELEGRAM_ENTRY_PRESET,
    source: { kind: 'telegram', key, title },
    launch: { kind: 'fields', fields },
  };
}
