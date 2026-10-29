import { gitBaseArgs } from './encoding.ts';
import { currentOs, factReason, hasValue, type OsKind } from './os-kind.ts';
import { longForm, pathKey } from './paths.ts';
import type { ProcessIdentity } from './process-table.ts';
import { listeningPorts, listWorktrees } from './resource-scan.ts';
import { runTool } from './run-tool.ts';
import { removeVerified } from './safe-io/remove.ts';
import { stopProcesses, type TreeStopDeps } from './tree-stop.ts';

/**
 * Снятие того, что сессия оставила (01 §Resources, P90, P40): каждое снятие кончается чтением
 * назад, и «снято» говорится только по нему. Не прочиталось — `leak` с причиной, не «снято»
 * (F25). Здесь только ОС; какие ресурсы снимать и что писать в журнал — дорога сессии ядра.
 */

export type ReleaseResult = { verified: string } | { leak: string };

export function releaseTmp(path: string): ReleaseResult {
  const removed = removeVerified(path);
  return removed.removed ? { verified: `${path} absent` } : { leak: removed.reason };
}

export async function releaseWorktree(
  ref: { worktree: string; repo: string },
  os: OsKind = currentOs(),
  run: typeof runTool = runTool,
): Promise<ReleaseResult> {
  const git = (args: string[]) =>
    run('git', [...gitBaseArgs(os), '-C', longForm(ref.repo, os), ...args], { timeoutMs: 60_000 });
  // `-f -f`, как у копии (`copy-git.ts`): одиночный `--force` запертую копию не снимает, и она
  // оставалась бы утечкой навсегда (F-191). «Снято» по-прежнему говорит только чтение назад.
  const removed = await git(['worktree', 'remove', '-f', '-f', ref.worktree]);
  await git(['worktree', 'prune']);
  const after = await listWorktrees(ref.repo, os);
  if (!hasValue(after)) return { leak: `worktree read-back: ${factReason(after)}` };
  const key = pathKey(ref.worktree, os);
  if (after.value.some((tree) => pathKey(tree.path, os) === key)) {
    return { leak: `worktree still listed${removed.ok ? '' : `: ${removed.reason}`}` };
  }
  return { verified: `worktree ${ref.worktree} not listed` };
}

export async function releaseProcess(
  id: ProcessIdentity,
  deps: TreeStopDeps = {},
): Promise<ReleaseResult> {
  const stopped = await stopProcesses([id], { graceMs: 2_000 }, deps);
  if (stopped.unknown) return { leak: `process read-back: ${stopped.unknown}` };
  return stopped.residual.length === 0
    ? { verified: `pid ${id.pid} gone` }
    : { leak: `pid ${id.pid} alive after stop` };
}

/** Порт снимается вместе с владельцем; чтение назад — таблица слушателей без этой пары. */
export async function releasePort(
  ref: { address: string; port: number; owner: ProcessIdentity },
  deps: TreeStopDeps = {},
  os: OsKind = currentOs(),
): Promise<ReleaseResult> {
  const owner = await releaseProcess(ref.owner, deps);
  const after = await listeningPorts(os);
  if (!hasValue(after)) return { leak: `port read-back: ${factReason(after)}` };
  const held = after.value.some((row) => row.port === ref.port && row.pid === ref.owner.pid);
  if (held) return { leak: `port ${ref.port} still listened by pid ${ref.owner.pid}` };
  return 'leak' in owner ? owner : { verified: `port ${ref.port} not listened` };
}
