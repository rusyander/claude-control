/**
 * Цель и подсказка действий outbox публикатора (`action.started` target / idempotencyHint) — ОДИН
 * формат на пишущего (публикатор) и читающего (сверка после краха, `bootstrap/action-readers`):
 * читатель получает только эти две строки и по ним обязан найти факт без памяти процесса.
 *
 * Цель начинается адресом пуша remote (по нему выбирается форж и идёт `ls-remote`); значения
 * доступа в адресе нет никогда — публикатор отдаёт их git парами окружения (G5), а адрес с
 * паролем здесь отказ: строка журнала живёт дольше любого ключа.
 */

export type ForgeActionKey =
  /** `before` — sha ветки на сервере до пуша; `null` — ветки не было. */
  | { kind: 'push'; url: string; ref: string; sha: string; before: string | null }
  | { kind: 'ref-delete'; url: string; ref: string; sha: string | null }
  | { kind: 'mr-create'; url: string; sourceBranch: string; bodyHash: string }
  | { kind: 'mr-update'; url: string; iid: number; bodyHash: string }
  | {
      kind: 'thread-reply';
      url: string;
      iid: number;
      threadId: string;
      bodyHash: string;
      /** Разрешение едет в том же действии (G15): «случилось» — только ответ И разрешение. */
      resolve: boolean;
    }
  /** Итог ревью по ссылке (этап 10, F8): одна заметка в MR, повтор находится по хешу тела. */
  | { kind: 'mr-comment'; url: string; iid: number; bodyHash: string };

const SHA = /^[0-9a-f]{40,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const WORD = /^\S+$/;

function assertUrl(url: string): void {
  if (!WORD.test(url)) throw new TypeError('forge action url must be one word');
  const scheme = url.match(/^[a-z+]+:\/\/([^@/]*)@/i);
  if (scheme?.[1]?.includes(':')) throw new TypeError('forge action url carries a password');
}

function assertWord(name: string, value: string): void {
  if (!WORD.test(value)) throw new TypeError(`forge action ${name} must be one word`);
}

export function forgeActionKey(key: ForgeActionKey): { target: string; idempotencyHint: string } {
  assertUrl(key.url);
  switch (key.kind) {
    case 'push':
      assertWord('ref', key.ref);
      return {
        target: `${key.url} ${key.ref}`,
        idempotencyHint: `${key.sha} ${key.before ?? '-'}`,
      };
    case 'ref-delete':
      assertWord('ref', key.ref);
      return { target: `${key.url} ${key.ref}`, idempotencyHint: key.sha ?? '-' };
    case 'mr-create':
      assertWord('branch', key.sourceBranch);
      return { target: `${key.url} ${key.sourceBranch}`, idempotencyHint: key.bodyHash };
    case 'mr-update':
      return { target: `${key.url} !${key.iid}`, idempotencyHint: key.bodyHash };
    case 'thread-reply':
      assertWord('thread', key.threadId);
      return {
        target: `${key.url} !${key.iid} ${key.threadId}`,
        idempotencyHint: `${key.bodyHash} ${key.resolve ? 'resolve' : 'reply'}`,
      };
    case 'mr-comment':
      return { target: `${key.url} !${key.iid}`, idempotencyHint: key.bodyHash };
  }
}

const iidOf = (text: string | undefined): number | null =>
  text && /^!\d+$/.test(text) ? Number(text.slice(1)) : null;

/** Разбор обратно; не та форма — `null` (читатель отвечает `unknown`, не «нет»). */
export function parseForgeActionKey(
  kind: ForgeActionKey['kind'],
  target: string,
  hint: string,
): ForgeActionKey | null {
  const [url, second, third, ...extra] = target.split(' ');
  const [h1, h2, ...hintExtra] = hint.split(' ');
  if (!url || !second || extra.length > 0 || hintExtra.length > 0 || !h1) return null;
  switch (kind) {
    case 'push':
      if (third !== undefined || !SHA.test(h1) || h2 === undefined) return null;
      if (h2 !== '-' && !SHA.test(h2)) return null;
      return { kind, url, ref: second, sha: h1, before: h2 === '-' ? null : h2 };
    case 'ref-delete':
      if (third !== undefined || h2 !== undefined || (h1 !== '-' && !SHA.test(h1))) return null;
      return { kind, url, ref: second, sha: h1 === '-' ? null : h1 };
    case 'mr-create':
      if (third !== undefined || h2 !== undefined || !HASH.test(h1)) return null;
      return { kind, url, sourceBranch: second, bodyHash: h1 };
    case 'mr-update':
    case 'mr-comment': {
      const iid = iidOf(second);
      if (iid === null || third !== undefined || h2 !== undefined || !HASH.test(h1)) return null;
      return { kind, url, iid, bodyHash: h1 };
    }
    case 'thread-reply': {
      const iid = iidOf(second);
      if (iid === null || !third || !HASH.test(h1) || (h2 !== 'resolve' && h2 !== 'reply'))
        return null;
      return { kind, url, iid, threadId: third, bodyHash: h1, resolve: h2 === 'resolve' };
    }
  }
}
