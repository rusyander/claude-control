import { tmpdir } from 'node:os';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { parseForgeActionKey, type ForgeActionKey } from '../../adapters/forge/index.ts';
import type { ActionFactReader, OpenAction } from '../../conductor/reconcile.ts';
import { absent } from '../../lib/facts/read-fact.ts';
import type { GitRunner } from '../../platform/git/git.types.ts';
import { lsRemote } from '../../platform/git/ls-remote.ts';
import { runTool } from '../../platform/run-tool.ts';
import { forgeForRemote } from '../panel-forge.ts';

/**
 * Читатели сверки действий публикации (05 §Push and MR, P10 половина читателя): только цель и
 * подсказка из `action.started` (формат `adapters/forge/action-keys.ts`), никакой памяти
 * процесса. Значение — свидетельство САМОГО действия; `absent` — его не было; сбой чтения —
 * исключение (сверка пишет `unknown`, повторяет до срока и спрашивает человека — никогда не
 * исполняет действие второй раз, P86).
 */

export interface ForgeReaderDeps {
  /** Порт форжа по адресу remote; по умолчанию — настройки и хранилище панели. */
  forgeFor?: (url: string) => ForgePort;
  /** Ссылка на сервере; по умолчанию — `git ls-remote` без рабочей копии. */
  lsRemote?: (url: string, ref: string) => Promise<Fact<Record<string, string>>>;
}

/**
 * Часы форжа и ядра расходятся: MR, созданный через секунду после записи `action.started`, по
 * часам форжа может оказаться «раньше». Окно назад — две минуты; MR той же ветки той же учётки
 * в этом окне — тот же самый, второго публикатор на одну ветку не открывает.
 */
export const FORGE_CLOCK_SKEW_MS = 120_000;

function keyOf<K extends ForgeActionKey['kind']>(
  kind: K,
  action: OpenAction,
): Extract<ForgeActionKey, { kind: K }> {
  const key = parseForgeActionKey(kind, action.target, action.idempotencyHint);
  if (!key || key.kind !== kind)
    throw new Error(`${kind} target/hint unreadable: ${action.target} | ${action.idempotencyHint}`);
  return key as Extract<ForgeActionKey, { kind: K }>;
}

/** Факт → значение; `absent` — `null`; `unknown` — исключение с причиной чтения. */
function known<T>(fact: Fact<T>): T | null {
  if ('unknown' in fact) throw new Error(fact.unknown);
  return 'absent' in fact ? null : fact.value;
}

/**
 * `ls-remote` без рабочей копии. Мусор вместо листинга — `unknown`, не «ветки нет»: строку не
 * вида `<sha> <ref>` отвергает сам разбор `parseLsRemote` (P44) — для пуша «нет» было бы
 * повторным пушем, для удаления — «удалено».
 */
export function remoteRefReader(run: GitRunner = runTool) {
  return (url: string, ref: string) => lsRemote(tmpdir(), url, [ref], { run });
}

export function forgeActionReaders(deps: ForgeReaderDeps = {}) {
  const forgeFor = deps.forgeFor ?? ((url: string) => forgeForRemote(url).port);
  const ls = deps.lsRemote ?? remoteRefReader();

  const push: ActionFactReader = (action) => async () => {
    const key = keyOf('push', action);
    const sha = known(await ls(key.url, key.ref))?.[key.ref];
    if (sha === key.sha) return `${key.ref} at ${sha}`;
    if (sha === undefined || sha === key.before) return absent();
    // Третий sha: ветку сдвинул кто-то другой — ни «было», ни «не было» (G11), спросить.
    throw new Error(`remote moved by another writer: ${key.ref} at ${sha}, pushed ${key.sha}`);
  };

  const refDelete: ActionFactReader = (action) => async () => {
    const key = keyOf('ref-delete', action);
    const sha = known(await ls(key.url, key.ref))?.[key.ref];
    if (sha === undefined) return absent();
    if (key.sha === null || sha === key.sha) return `${key.ref} at ${sha}`;
    throw new Error(`remote moved by another writer: ${key.ref} at ${sha}, deleting ${key.sha}`);
  };

  const mrCreate: ActionFactReader = (action) => async () => {
    const key = keyOf('mr-create', action);
    const port = forgeFor(key.url);
    const me = known(await port.whoAmI());
    if (!me) throw new Error('forge account unreadable');
    const mr = known(
      await port.mrBySourceBranch({
        sourceBranch: key.sourceBranch,
        createdAfter: action.startedAt - FORGE_CLOCK_SKEW_MS,
        author: me.username,
      }),
    );
    return mr ? `!${mr.iid} ${mr.url}` : absent();
  };

  const mrUpdate: ActionFactReader = (action) => async () => {
    const key = keyOf('mr-update', action);
    const mr = known(await forgeFor(key.url).mr(key.iid));
    // Сам MR есть и до правки: доказывает только хэш заголовка и описания (G10).
    return mr && mr.bodyHash === key.bodyHash ? `!${mr.iid} ${mr.bodyHash}` : absent();
  };

  const threadReply: ActionFactReader = (action) => async () => {
    const key = keyOf('thread-reply', action);
    const port = forgeFor(key.url);
    const me = known(await port.whoAmI());
    if (!me) throw new Error('forge account unreadable');
    const thread = known(await port.threads(key.iid))?.find((t) => t.id === key.threadId);
    const note = thread?.notes.find(
      (n) =>
        n.author === me.username &&
        n.bodyHash === key.bodyHash &&
        n.createdAt >= action.startedAt - FORGE_CLOCK_SKEW_MS,
    );
    if (!thread || !note) return absent();
    // Ответ дошёл, разрешение — нет: «случилось» лишь наполовину, решает человек (G15).
    if (key.resolve && !thread.resolved)
      throw new Error(`reply ${note.id} found, thread ${key.threadId} not resolved`);
    return `!${key.iid} ${key.threadId} note ${note.id}`;
  };

  // Итог ревью по ссылке (этап 10, F8): своя заметка с тем же хешем тела после начала действия.
  const mrComment: ActionFactReader = (action) => async () => {
    const key = keyOf('mr-comment', action);
    const port = forgeFor(key.url);
    const me = known(await port.whoAmI());
    if (!me) throw new Error('forge account unreadable');
    const note = known(await port.comments(key.iid))?.find(
      (n) =>
        n.author === me.username &&
        n.bodyHash === key.bodyHash &&
        n.createdAt >= action.startedAt - FORGE_CLOCK_SKEW_MS,
    );
    return note ? `!${key.iid} note ${note.id}` : absent();
  };

  return {
    push,
    'ref-delete': refDelete,
    'mr-create': mrCreate,
    'mr-update': mrUpdate,
    'thread-reply': threadReply,
    'mr-comment': mrComment,
    // Трекера в ядре нет (решение G3): запись в трекер не доказать — всегда спросить человека.
    'tracker-write': () => () => {
      throw new Error('no core tracker adapter');
    },
  } satisfies Record<string, ActionFactReader>;
}
