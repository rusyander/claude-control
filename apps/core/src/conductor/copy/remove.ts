import { join } from 'node:path';
import type { LiveTask } from '../../journal/resume.ts';
import { sameFileBytes } from '../../platform/copy-fs.ts';
import {
  copyState,
  dirtyPaths,
  mainWorktree,
  worktreeListed,
  type DirtyPath,
} from '../../platform/copy-git.ts';
import { samePath } from '../../platform/paths.ts';
import { releaseWorktree } from '../../platform/resource-release.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { ActionFailed, runAction } from '../outbox.ts';
import type { MirrorSettings } from './copy.types.ts';
import { copyResourceOf } from './journal-view.ts';
import { effectiveSettings, wanted } from './mirror-plan.ts';
import { LOCKFILES } from './setup.ts';

/**
 * Снятие копии единицы — место применения действия `copy-remove` (01 §Resources, P26): «снято»
 * говорится по чтению назад (каталога нет, git его не перечисляет). Снимается только своя копия:
 * запись ресурса `copy` этой единицы в журнале задачи на этот каталог — иначе отказ, будь то
 * рабочее дерево человека или копия другой единицы. Основная копия не снимается никогда. Грязь
 * копии разбирается по именам (перенесено из панели, `dirtIsOnlyLocalLayer`): локальный слой и
 * lock-файлы положило само ядро, а любой другой незакоммиченный путь — работа, и без `force`
 * копия с ней не снимается.
 */

export interface CopyRemoveInput {
  repo: string;
  dir: string;
  branch: string;
  settings?: MirrorSettings;
  /** Снять и с чужой незакоммиченной работой (решение человека, не ядра). */
  force?: boolean;
}

export type CopyRemoveResult =
  { ok: true; verified: string } | { ok: false; refused: string } | { ok: false; failed: string };

/**
 * Путь положило ядро: неотслеживаемый файл под списком зеркала или с именем lock-файла. Правка
 * ОТСЛЕЖИВАЕМОГО файла — работа агента (правило в `.claude/`, `.mcp.json`, обновлённый lock-файл:
 * переписанное установкой ядро откатило ещё на настройке), кроме одного случая — файл побайтно
 * равен основной копии: это правка человека, которую принесло зеркало.
 */
function ownDirt(dirt: DirtyPath, settings: MirrorSettings, copy: string, main: string): boolean {
  const name = dirt.path.slice(dirt.path.lastIndexOf('/') + 1);
  if (!wanted(dirt.path, settings) && !LOCKFILES.includes(name)) return false;
  return !dirt.tracked || sameFileBytes(join(copy, dirt.path), join(main, dirt.path));
}

function why(fact: { unknown: string } | { absent: true }): string {
  return 'unknown' in fact ? fact.unknown : 'absent';
}

/** Проверки до снятия: каталог на месте — он дерево этого репозитория и без чужой работы. */
async function refusalOf(input: CopyRemoveInput, main: string): Promise<string | undefined> {
  const listed = await worktreeListed(input.repo, input.dir);
  if (!('value' in listed)) return `worktree list unread: ${why(listed)}`;
  if (!listed.value) return `${input.dir} is not a worktree of ${input.repo}`;
  if (input.force) return undefined;
  const dirt = await dirtyPaths(input.dir);
  if (!('value' in dirt)) return `copy status unread: ${why(dirt)}`;
  const settings = effectiveSettings(input.settings);
  const foreign = dirt.value
    .filter((d) => !ownDirt(d, settings, input.dir, main))
    .map((d) => d.path);
  if (foreign.length === 0) return undefined;
  const more = foreign.length > 5 ? ` (+${foreign.length - 5})` : '';
  return `uncommitted work in the copy: ${foreign.slice(0, 5).join(', ')}${more}`;
}

export async function removeUnitCopy(
  task: LiveTask,
  unitId: string,
  input: CopyRemoveInput,
): Promise<CopyRemoveResult> {
  const main = await mainWorktree(input.repo);
  if (!('value' in main)) return { ok: false, refused: `main checkout unread: ${why(main)}` };
  if (samePath(main.value, input.dir))
    return { ok: false, refused: 'the main checkout is never removed' };
  const resource = copyResourceOf(task, input.dir, (a, b) => samePath(a, b));
  if (!resource || resource.unitId !== unitId)
    return { ok: false, refused: `${input.dir} is not a copy of unit ${unitId} in this task` };
  const state = copyState(input.dir);
  if ('unknown' in state) return { ok: false, refused: `copy unread: ${state.unknown}` };
  // Каталога уже нет (снят руками, прошлая уборка) — git всё равно держит запись и ветку: снятие
  // идёт тем же путём (prune + чтение назад), и запись ресурса закрывается его исходом.
  if (!('absent' in state)) {
    const refused = await refusalOf(input, main.value);
    if (refused) return { ok: false, refused };
  }
  const done = await runAction(
    task,
    { kind: 'copy-remove', target: input.dir, idempotencyHint: input.branch },
    async () => {
      const released = await releaseWorktree({ worktree: input.dir, repo: input.repo });
      if ('leak' in released) throw new ActionFailed('worktree-remove', released.leak);
      // git снял дерево из списка, а каталог мог остаться (игнорируемое, держатель файла): добор.
      if (!('absent' in copyState(input.dir))) {
        const swept = removeVerified(input.dir);
        if (!swept.removed) throw new ActionFailed('dir-remains', swept.reason);
      }
      return released.verified;
    },
    { unitId },
  );
  // Запись ресурса копии закрывается тем же исходом: снято по чтению назад — verified, нет — leak.
  const status = task.state.resources[resource.rid]?.status;
  if (status === 'live')
    task.append({ kind: 'resource.released', actor: 'core', unitId, data: { rid: resource.rid } });
  if (!done.ok) {
    if (status !== 'verified')
      task.append({
        kind: 'resource.leak',
        actor: 'core',
        unitId,
        data: { rid: resource.rid, reason: `copy-remove ${done.code}` },
      });
    return { ok: false, failed: `copy-remove ${done.code}` };
  }
  const fact = String(done.result);
  if (status !== 'verified')
    task.append({
      kind: 'resource.verified',
      actor: 'core',
      unitId,
      data: { rid: resource.rid, fact },
    });
  return { ok: true, verified: fact };
}
