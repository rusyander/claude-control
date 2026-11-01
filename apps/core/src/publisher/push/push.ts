import { forgeActionKey } from '../../adapters/forge/index.ts';
import type { PushMode, PushResult } from '../../platform/git/push.ts';
import type { OutboxPort } from './push.types.ts';

/**
 * Пуш ветки единицы через outbox (05 §Push and MR): цель `<адрес> refs/heads/<b>`, подсказка —
 * sha и прежний sha сервера (формат сверки F, `forgeActionKey`). До MR — аренда ровно по sha
 * сервера; после MR — никогда силой (правки уходят новыми коммитами).
 */

export interface PushInput {
  /** Настоящий адрес пуша без доступа (P: доступ — парами окружения). */
  url: string;
  branch: string;
  sha: string;
  /** sha ветки на сервере сейчас; `null` — ветки нет. */
  before: string | null;
  mrExists: boolean;
}

export type PushOutcome =
  | { kind: 'pushed'; actionId: string }
  /** Сервер уже держит этот sha — пушить нечего (повтор после краха, P10). */
  | { kind: 'already' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'failed'; code: string };

export function pushModeOf(input: Pick<PushInput, 'before' | 'mrExists'>): PushMode {
  return input.mrExists ? { kind: 'fast-forward' } : { kind: 'lease', expect: input.before };
}

export async function pushUnit(
  deps: { outbox: OutboxPort; push(mode: PushMode): Promise<PushResult> },
  input: PushInput,
): Promise<PushOutcome> {
  if (input.before === input.sha) return { kind: 'already' };
  const ref = `refs/heads/${input.branch}`;
  const key = forgeActionKey({
    kind: 'push',
    url: input.url,
    ref,
    sha: input.sha,
    before: input.before,
  });
  const mode = pushModeOf(input);
  const box: { rejected: string | null } = { rejected: null };
  const got = await deps.outbox.run({ kind: 'push', ...key }, async () => {
    const res = await deps.push(mode);
    if (res.kind === 'rejected') {
      box.rejected = res.detail;
      return { ok: false, code: 'push-rejected', detail: res.detail };
    }
    return { ok: true, result: { ref, sha: input.sha } };
  });
  if (got.ok) return { kind: 'pushed', actionId: got.actionId };
  if (box.rejected !== null) return { kind: 'rejected', detail: box.rejected };
  return { kind: 'failed', code: got.code };
}
