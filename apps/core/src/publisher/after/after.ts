import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgePort, ForgeThread } from '@agentdeck/contracts/core/forge';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { forgeActionKey, noteHash } from '../../adapters/forge/index.ts';
import type { OutboxPort } from '../push/push.types.ts';

/**
 * После публикации (05 §After publish): нити и конфликт читаются ОДИН раз при открытии MR;
 * ответы уходят из `step_done.replies` через outbox `thread-reply` (разрешение — в том же
 * действии, G15); CI читается только когда живое решение человека для ЭТОЙ задачи просило его
 * ждать (P64) и не было «опубликовать сейчас».
 */

export type ReadRecord = Omit<JournalDataV1['publish.read'], 'unitId'>;

const why = <T>(f: Fact<T>): string => ('unknown' in f ? f.unknown : 'absent');

/** Нить ревьюера: её можно разрешить и в ней пишет не наш аккаунт. */
export function reviewerThreads(threads: readonly ForgeThread[], self: string): ForgeThread[] {
  return threads.filter((t) => t.resolvable && t.notes.some((n) => n.author !== self));
}

export async function readOnce(
  forge: ForgePort,
  input: { iid: number; self: string; localConflict: boolean },
): Promise<{ value: ReadRecord } | { unknown: string }> {
  const [threads, merge] = await Promise.all([
    forge.threads(input.iid),
    forge.mergeability(input.iid),
  ]);
  if (!('value' in threads)) return { unknown: `threads: ${why(threads)}` };
  if (!('value' in merge)) return { unknown: `mergeability: ${why(merge)}` };
  if (merge.value === 'checking') return { unknown: 'mergeability: the forge is still checking' };
  const reviewer = reviewerThreads(threads.value, input.self);
  return {
    value: {
      mrIid: input.iid,
      threads: reviewer.map((t) => ({ id: t.id, resolved: t.resolved })),
      conflict: input.localConflict || merge.value === 'conflict',
      notes: reviewer.flatMap((t) =>
        t.notes.filter((n) => n.author !== input.self).map((n) => n.id),
      ),
    },
  };
}

/** Предел одной заметки в брифе: длинная нить не съедает контекст шага. */
export const THREAD_NOTE_MAX = 2000;

/**
 * Текст брифа шага `answer-reviewers`: каждая открытая нить ревьюера с её заметками — то, на что
 * шаг отвечает полем `replies` (`threadId`, `text`, `resolve`). Открытых нет — `null`.
 */
export function threadsBrief(threads: readonly ForgeThread[], self: string): string | null {
  const open = reviewerThreads(threads, self).filter((t) => !t.resolved);
  if (open.length === 0) return null;
  const clip = (s: string) =>
    s.length > THREAD_NOTE_MAX ? `${s.slice(0, THREAD_NOTE_MAX)} […]` : s;
  const blocks = open.map((t) =>
    [`thread ${t.id}:`, ...t.notes.map((n) => `  ${n.author}: ${clip(n.body)}`)].join('\n'),
  );
  return [
    `Open reviewer threads (${open.length}). Answer each in step_done.replies by threadId; ` +
      'resolve only a thread the change fully settles.',
    ...blocks,
  ].join('\n\n');
}

export interface Reply {
  threadId: string;
  text: string;
  resolve: boolean;
}

export type ReplyOutcome =
  | { kind: 'sent'; threadId: string }
  | { kind: 'skipped'; threadId: string; why: 'already-done' }
  | { kind: 'failed'; threadId: string; code: string };

/**
 * Ответы ревьюерам. Своя заметка с тем же хешем уже в нити (ответ ушёл, разрешение — нет) —
 * второй заметки не будет: остаётся только разрешение. Готовые действия outbox не повторяются.
 */
export async function sendReplies(
  deps: { forge: ForgePort; outbox: OutboxPort; self: string },
  input: {
    url: string;
    iid: number;
    replies: readonly Reply[];
    threads: readonly ForgeThread[];
    doneHints: ReadonlySet<string>;
  },
): Promise<ReplyOutcome[]> {
  const out: ReplyOutcome[] = [];
  for (const r of input.replies) {
    const bodyHash = noteHash(r.text);
    const key = forgeActionKey({
      kind: 'thread-reply',
      url: input.url,
      iid: input.iid,
      threadId: r.threadId,
      bodyHash,
      resolve: r.resolve,
    });
    if (input.doneHints.has(`${key.target}\n${key.idempotencyHint}`)) {
      out.push({ kind: 'skipped', threadId: r.threadId, why: 'already-done' });
      continue;
    }
    const thread = input.threads.find((t) => t.id === r.threadId);
    const noted = thread?.notes.some((n) => n.author === deps.self && n.bodyHash === bodyHash);
    const got = await deps.outbox.run({ kind: 'thread-reply', ...key }, async () => {
      if (!noted) {
        const sent = await deps.forge.reply(input.iid, r.threadId, r.text);
        if (!('value' in sent)) {
          const detail = 'unknown' in sent ? sent.unknown : sent.unsupported;
          return { ok: false, code: 'reply-failed', detail };
        }
      }
      if (r.resolve && !thread?.resolved) {
        const done = await deps.forge.resolve(input.iid, r.threadId);
        if (!('value' in done)) {
          const detail = 'unknown' in done ? done.unknown : done.unsupported;
          return { ok: false, code: 'resolve-failed', detail };
        }
      }
      return { ok: true, result: { threadId: r.threadId, bodyHash, resolved: r.resolve } };
    });
    out.push(
      got.ok
        ? { kind: 'sent', threadId: r.threadId }
        : { kind: 'failed', threadId: r.threadId, code: got.code },
    );
  }
  return out;
}

/** Ждать ли CI сейчас: только живое решение этой задачи и без «опубликовать сейчас» (P64, P96). */
export function wantsCi(input: { ciWait: boolean; publishNow: boolean }): boolean {
  return input.ciWait && !input.publishNow;
}
