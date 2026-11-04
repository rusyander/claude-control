import { FORGE_CLOUD, hostOf } from '@agentdeck/contracts/core/forge';
import type { McpServerEntry } from '../adapter.types.ts';
import type { ForgeActionKey } from './action-keys.ts';

/**
 * Правило `forge-mcp-read-only` (05 §Only the core publishes, P82): сервер MCP человека, который
 * говорит с форжем (GitLab, GitHub, Gitea…), в сеансе ядра только читает. Публикация — пуш, MR,
 * заметка, ответ в обсуждении, метка — идёт одной дорогой публикатора ядра; инструмент записи
 * такого сервера обошёл бы её (и журнал outbox, и сверку `forged-publish`).
 *
 * Инструменты сервера человека до сеанса не перечисляются (это запуск чужого процесса), поэтому
 * правило судит ИМЯ в момент вызова — хуком ядра и сервером права (`decidePermit`). Разрешено
 * только доказанное чтение: ведущий или замыкающий глагол из словаря чтения и ни одного глагола
 * записи. Глагол записи — отказ, незнакомое имя — тоже отказ («не доказано, что читает»): новый
 * инструмент записи у сервера не проходит молча.
 *
 * Словарь записи выведен из каталога действий публикатора (`ForgeActionKey['kind']`): у каждого
 * вида действия — глаголы, которыми его назвал бы инструмент MCP. Новый вид действия без своей
 * строки здесь — ошибка типов, а не молчаливая дыра.
 */

export const FORGE_MCP_RULE = 'forge-mcp-read-only';

/**
 * Глаголы инструментов MCP по виду действия публикатора. Слова-«существительные» (merge, commit,
 * note, comment, label, review, push) судятся только ведущим словом: `get_commit`,
 * `list_merge_requests` — чтение.
 */
const ACTION_VERBS: Readonly<Record<ForgeActionKey['kind'], readonly string[]>> = {
  push: ['push', 'commit', 'upload'],
  'ref-delete': ['delete', 'remove', 'destroy'],
  'mr-create': ['create', 'open', 'new', 'fork', 'submit'],
  'mr-update': [
    'update',
    'edit',
    'set',
    'merge',
    'approve',
    'unapprove',
    'close',
    'reopen',
    'label',
    'assign',
    'unassign',
    'rebase',
  ],
  'thread-reply': ['reply', 'resolve', 'unresolve', 'react'],
  'mr-comment': ['comment', 'note', 'review', 'post', 'add'],
};

/**
 * Глаголы записи, которые в именах инструментов форжа не бывают существительными: найденный в
 * ЛЮБОМ месте имени — запись (`mark_all_notifications_read`, `pull_request_review_write`).
 */
const PURE_WRITE: ReadonlySet<string> = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'destroy',
  'edit',
  'write',
  'add',
  'set',
  'upload',
  'submit',
  'approve',
  'unapprove',
  'resolve',
  'unresolve',
  'reply',
  'react',
  'close',
  'reopen',
  'fork',
  'rebase',
  'assign',
  'unassign',
  'mark',
  'dismiss',
  'star',
  'unstar',
  'subscribe',
  'unsubscribe',
  'trigger',
  'cancel',
  'retry',
  'rerun',
  'execute',
  'publish',
  'transfer',
  'archive',
  'unarchive',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'protect',
  'unprotect',
  'enable',
  'disable',
  'toggle',
  'apply',
  'revert',
  'move',
  'rename',
  'accept',
  'reject',
  'invite',
  'share',
  'import',
  'export',
]);

/** Глаголы записи ведущим словом: каталог действий публикатора + чистые глаголы записи. */
const LEADING_WRITE: ReadonlySet<string> = new Set([
  ...Object.values(ACTION_VERBS).flat(),
  ...PURE_WRITE,
]);

/** Глаголы чтения: ведущим или замыкающим словом (`get_issue`, `issue_read`). */
export const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'search',
  'read',
  'view',
  'show',
  'find',
  'describe',
  'download',
  'fetch',
]);

export type ForgeToolClass = 'read' | 'write' | 'unknown';

/** Слова имени: `createMergeRequest`, `create-merge.request`, `create_merge_request` → одни слова. */
function wordsOf(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Класс инструмента сервера форжа по имени (без приставки `mcp__<server>__`). */
export function forgeToolClass(tool: string): ForgeToolClass {
  const words = wordsOf(tool);
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) return 'unknown';
  if (LEADING_WRITE.has(first) || words.some((w) => PURE_WRITE.has(w))) return 'write';
  if (READ_VERBS.has(first) || READ_VERBS.has(last)) return 'read';
  return 'unknown';
}

/** Слова, по которым сервер узнаётся как форж: виды облака ядра + известные форжи вне панели. */
const FORGE_WORDS: readonly string[] = [
  ...Object.keys(FORGE_CLOUD),
  'gitea',
  'forgejo',
  'bitbucket',
  'codeberg',
];

const wordIn = (text: string): string | undefined => {
  const low = text.toLowerCase();
  return FORGE_WORDS.find((w) => low.includes(w));
};

/**
 * Сервер человека говорит с форжем? Улики: слово форжа в имени, команде, аргументах, адресе или
 * ИМЕНИ переменной окружения (`GITLAB_PERSONAL_ACCESS_TOKEN`), хост настроенного форжа панели в
 * адресе, аргументах или значении переменной. Возвращает улику (без значений переменных: там
 * ключи) или `null`.
 */
export function forgeServerEvidence(
  id: string,
  entry: McpServerEntry,
  hosts: readonly string[],
): string | null {
  const byName = wordIn(id);
  if (byName) return `name has «${byName}»`;
  const known = hosts.map((h) => h.toLowerCase()).filter(Boolean);
  const hostIn = (text: string): string | undefined => {
    const low = text.toLowerCase();
    return known.find((h) => hostOf(low) === h || low.includes(h));
  };
  if (entry.url !== undefined) {
    const word = wordIn(entry.url);
    if (word) return `url has «${word}»`;
    const host = hostIn(entry.url);
    if (host) return `url is the configured forge ${host}`;
    return null;
  }
  for (const part of [entry.command, ...entry.args]) {
    const word = wordIn(part);
    if (word) return `launch has «${word}»`;
    const host = hostIn(part);
    if (host) return `launch names the configured forge ${host}`;
  }
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    const word = wordIn(name);
    if (word) return `env ${name}`;
    const host = hostIn(value);
    if (host) return `env ${name} names the configured forge ${host}`;
  }
  return null;
}

export interface ForgeServer {
  id: string;
  why: string;
}

/** Серверы человека шага, которые правило держит только на чтении. */
export function forgeMcpServers(
  human: Readonly<Record<string, McpServerEntry>>,
  hosts: readonly string[],
): ForgeServer[] {
  const out: ForgeServer[] = [];
  for (const [id, entry] of Object.entries(human)) {
    const why = forgeServerEvidence(id, entry, hosts);
    if (why) out.push({ id, why });
  }
  return out;
}

/**
 * Имя сервера в полном имени инструмента: CLI заменяет в нём всё, кроме букв, цифр, `_` и `-`,
 * на `_` (Claude Code, Qwen Code — `mcp__<server>__<tool>`).
 */
const toolServerName = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Решение правила по полному имени инструмента: не сервер форжа — `null` (правило молчит);
 * иначе класс инструмента и сервер. Сервер с самым длинным совпавшим именем — `a__b` раньше `a`.
 */
export function forgeMcpVerdict(
  fullName: string,
  servers: readonly string[],
): { server: string; tool: string; cls: ForgeToolClass } | null {
  const hit = servers
    .map((id) => ({ id, prefix: `mcp__${toolServerName(id)}__` }))
    .filter((s) => fullName.startsWith(s.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!hit) return null;
  const tool = fullName.slice(hit.prefix.length);
  return { server: hit.id, tool, cls: forgeToolClass(tool) };
}
