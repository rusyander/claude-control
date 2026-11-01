import type { Fact } from '@agentdeck/contracts/core/facts';
import { forgeActionKey } from '../../adapters/forge/index.ts';
import type { CleanRemoteReport } from '../../conductor/commands/publisher-port.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { lsRemote } from '../../platform/git/ls-remote.ts';
import { repoHooksPath } from '../../platform/git/push-closure.ts';
import { deleteRemoteRef } from '../../platform/git/push.ts';
import { publisherPushSpec } from '../../publisher/closure/index.ts';
import { outboxPort } from './outbox-port.ts';
import { pushUrlOf } from './unit-view.ts';

/**
 * `clean-remote` (P102) по каждому репозиторию задачи: читается, какие из НАЗВАННЫХ ссылок есть
 * на сервере; каждая найденная удаляется действием outbox `ref-delete` (ключ сверки зоны F) с
 * арендой по прочитанному sha; потом сервер читается снова — удалено то, чего там больше нет.
 * Ссылка, которой не называли, не читается и не трогается.
 */

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

export async function cleanRemote(
  task: LiveTask,
  input: { refs: string[]; remote: string | null },
  git: GitOptions = {},
): Promise<CleanRemoteReport | { unknown: string }> {
  const report: CleanRemoteReport = { deleted: [], absent: [], failed: [] };
  const outbox = outboxPort(task);
  for (const repo of task.state.created?.repos ?? []) {
    const pushUrl = await pushUrlOf(repo.path, input.remote ?? 'origin', git);
    if (!('value' in pushUrl)) return pushUrl;
    const url = pushUrl.value;
    const hooks = await repoHooksPath(repo.path, git);
    if (!('value' in hooks)) return { unknown: `hooks path: ${why(hooks)}` };
    const route = publisherPushSpec({ url, repoHooksPath: hooks.value, credential: null });
    const seen = await lsRemote(repo.path, url, input.refs, git);
    if ('unknown' in seen) return { unknown: `refs on the server: ${seen.unknown}` };
    const present = 'value' in seen ? seen.value : {};
    report.absent.push(...input.refs.filter((ref) => !present[ref]));
    for (const [ref, sha] of Object.entries(present)) {
      // `ls-remote <шаблон>` сверяет ХВОСТ имени: `refs/heads/b` находит и `refs/tags/x/refs/heads/b`.
      // Удаляется только названное дословно.
      if (!input.refs.includes(ref)) continue;
      const key = forgeActionKey({ kind: 'ref-delete', url, ref, sha });
      const got = await outbox.run({ kind: 'ref-delete', ...key }, async () => {
        const res = await deleteRemoteRef(repo.path, route, ref, sha, git);
        return res.kind === 'pushed'
          ? { ok: true, result: { ref, sha } }
          : { ok: false, code: 'ref-delete-rejected', detail: res.detail };
      });
      if (!got.ok) report.failed.push({ ref, code: got.code });
    }
    const after = await lsRemote(repo.path, url, input.refs, git);
    if ('unknown' in after) return { unknown: `refs after delete: ${after.unknown}` };
    const left = 'value' in after ? after.value : {};
    for (const ref of input.refs) {
      if (!present[ref] || report.failed.some((x) => x.ref === ref)) continue;
      if (left[ref]) report.failed.push({ ref, code: 'still-present' });
      else report.deleted.push(ref);
    }
  }
  return report;
}
