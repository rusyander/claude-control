import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { commitOf } from '../../platform/copy-git.ts';
import { mergeHeads } from '../../platform/git/merge-heads.ts';
import { git as runGit } from '../../platform/git/run.ts';
import { isIntegrationUnit } from '../gates/integrated.ts';
import { unitCopyOf } from './journal-view.ts';

/**
 * Основа копии единицы интеграции (этап 11, W3-18b): слияние голов всех её незакрытых единиц того
 * же репозитория (`merge-tree --write-tree` + `commit-tree`, только объекты — ни ветки, ни пуша).
 * Конфликт — копии нет: сигнал `integration-conflict` называет файлы и пару голов, шаг ворот
 * интеграции красный и на каждом круге сливает головы заново (`gates/integration-hooks.ts`), единицы
 * ждут. Не единица интеграции — `undefined` (основа как была).
 */

export const INTEGRATION_CONFLICT_SIGNAL = 'integration-conflict';

export async function integrationBaseOf(
  task: LiveTask,
  unitId: string,
  repoPath: string,
  git: GitOptions = {},
): Promise<string | { unknown: string } | undefined> {
  const unit = task.state.units[unitId];
  if (!unit || !isIntegrationUnit(unit)) return undefined;
  // Закрытая единица не публикуется — её голова не часть общего изменения: слить её значило бы
  // проверять не то, что уйдёт в MR, а её конфликт держал бы публикацию живых единиц.
  const parts = unit.after
    .map((id) => task.state.units[id])
    .filter((u) => u !== undefined && u.repoKey === unit.repoKey && u.state !== 'closed');
  if (parts.length === 0)
    return { unknown: `integration ${unitId}: no open unit of ${unit.repoKey}` };
  const heads = parts.map((u) => `refs/heads/${u!.branch}`);
  const merged = await mergeHeads(repoPath, heads, git);
  if (!('value' in merged))
    return { unknown: `integration merge: ${'unknown' in merged ? merged.unknown : 'absent'}` };
  if (merged.value.kind === 'clean') return merged.value.commit;
  const { files, between } = merged.value;
  const pair = between.map((h) => h.replace(/^refs\/heads\//, '')).join(' + ');
  const detail = `integration-conflict: ${files.join(', ')} (${pair})`;
  task.append({
    kind: 'signal',
    actor: 'core',
    unitId,
    data: {
      signal: INTEGRATION_CONFLICT_SIGNAL,
      severity: 'warn',
      subject: unitId,
      detail: JSON.stringify({
        files,
        between: between.map((h) => h.replace(/^refs\/heads\//, '')),
      }),
    },
  });
  return { unknown: detail };
}

/**
 * Новый круг ворот интеграции (P135 «зелёное до КАЖДОЙ публикации», Q-1 ревью s11-w3): копия
 * интеграции уже лежит, а голова единицы могла сдвинуться (правка после MR, ответ ревьюерам) —
 * головы сливаются заново и копия переходит на новый коммит слияния. Только своя локальная ветка
 * копии ядра, без пуша; те же головы дают тот же sha (`merge-heads.ts`) — повтор после краха
 * приходит туда же. Конфликт — сигнал `integration-conflict` (его пишет `integrationBaseOf`),
 * копия остаётся на прежнем слиянии, причина названа.
 */
export async function remergeIntegration(
  task: LiveTask,
  unitId: string,
  copy: { dir: string; repo: string },
  git: GitOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const merged = await integrationBaseOf(task, unitId, copy.repo, git);
  if (merged === undefined) return { ok: true };
  if (typeof merged !== 'string') return { ok: false, reason: merged.unknown };
  const head = await commitOf(copy.dir, 'HEAD', git);
  if (!('value' in head))
    return {
      ok: false,
      reason: `integration copy HEAD: ${'unknown' in head ? head.unknown : 'absent'}`,
    };
  if (head.value === merged) return { ok: true };
  try {
    await runGit(copy.dir, ['reset', '--hard', '--quiet', merged], { ...git, timeoutMs: 60_000 });
  } catch (error) {
    return {
      ok: false,
      reason: `integration copy move to ${merged.slice(0, 12)}: ${String(error)}`,
    };
  }
  return { ok: true };
}

/**
 * Покрыта ли голова единицы последним слиянием интеграции: голова ветки единицы — предок HEAD
 * копии интеграции. Нет — строка причины (публикация отказывает с `reintegrate`); git не ответил
 * или копии нет — тоже причина: непрочитанное покрытие зелёным не считается.
 */
export async function headOutsideIntegration(
  task: LiveTask,
  unitId: string,
  integrationId: string,
  git: GitOptions = {},
): Promise<string | null> {
  const unit = task.state.units[unitId];
  if (!unit) return `unit ${unitId} is not in the task fold`;
  const copy = unitCopyOf(task, integrationId);
  if (!copy) return `integration ${integrationId} has no copy to compare the head with`;
  const head = await commitOf(copy.repo, `refs/heads/${unit.branch}`, git);
  if (!('value' in head))
    return `head of ${unit.branch}: ${'unknown' in head ? head.unknown : 'absent'}`;
  const merged = await commitOf(copy.dir, 'HEAD', git);
  if (!('value' in merged))
    return `integration copy HEAD: ${'unknown' in merged ? merged.unknown : 'absent'}`;
  try {
    const out = await runGit(copy.repo, ['merge-base', '--is-ancestor', head.value, merged.value], {
      ...git,
      timeoutMs: 30_000,
      acceptNonZero: true,
    });
    if (out.code === 0) return null;
    if (out.code === 1)
      return `head ${head.value.slice(0, 12)} of ${unit.branch} is not in the last green integration ${merged.value.slice(0, 12)}`;
    return `merge-base --is-ancestor exited ${String(out.code)}`;
  } catch (error) {
    return `merge-base --is-ancestor: ${String(error)}`;
  }
}
