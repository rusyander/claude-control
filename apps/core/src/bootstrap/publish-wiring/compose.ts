import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { treeFp } from '../../conductor/outcomes/final-gate.ts';
import type { HookVerdict, UnitCtx } from '../../conductor/run/run.types.ts';
import { presetOf, readLibraryScenario } from '../../conductor/scenario/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { readCommitMessages } from '../../platform/git/messages.ts';
import { treeRows } from '../../platform/git/tree.ts';
import { composeUnit } from '../../publisher/compose/compose.ts';
import { detectConvention, loadPublishTextConfig, sieveText } from '../../publisher/text/index.ts';
import { unitViewOf } from './unit-view.ts';

/**
 * Композиция коммитов под состав финальной проверки (05 §Commit shape, P67): только когда
 * сценарий задачи публикует и проверка сдана с составом. Дерево HEAD после сборки обязано быть
 * деревом, которое проверяли (рабочее дерево копии на момент итога): не то — шаг заново, а не
 * публикация непроверенного. Строка `publish.composed` несёт это дерево; публикатор сравнивает
 * дерево, а не sha (перебазировка и смена сообщений sha меняют, дерево — нет).
 */

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');
const stop = (code: string, reason: string): HookVerdict => ({
  ok: false,
  stop: 'step',
  code,
  reason,
});

export async function scenarioPublishes(task: LiveTask, scenariosDir: string): Promise<boolean> {
  const ref = task.state.scenario?.ref ?? task.state.created?.scenario;
  if (!ref) return false;
  let scenario: Scenario | undefined = presetOf(ref);
  if (!scenario) {
    const got = await readLibraryScenario(scenariosDir, ref);
    if (got.kind === 'value') scenario = got.scenario;
  }
  return scenario?.steps.some((s) => s.kind === 'publish') ?? false;
}

/** Сообщение коммита единицы из журнала: заголовок задачи и имя единицы, если их несколько. */
export function unitMessageOf(task: LiveTask, unitId: string): string {
  const title = (task.state.created?.title ?? 'Update').replace(/\s+/g, ' ').trim();
  const units = Object.keys(task.state.units).length;
  const name = task.state.units[unitId]?.name;
  return units > 1 && name ? `${title} (${name})` : title;
}

export async function composeForGate(
  task: LiveTask,
  u: UnitCtx,
  compositionId: string,
  deps: { coreHome: string; git: GitOptions },
): Promise<HookVerdict> {
  const view = await unitViewOf(task, u.unitId, deps.git);
  if (!('value' in view)) return stop('compose-unknown', view.unknown);
  const { copyDir, base, branch, sourceRepo } = view.value;
  const gated = await treeRows(copyDir, 'worktree', deps.git);
  if (!('value' in gated)) return stop('compose-unknown', `worktree tree: ${why(gated)}`);
  const fp = treeFp(gated.value);
  const config = await loadPublishTextConfig(deps.coreHome);
  if (!('value' in config)) return stop('compose-unknown', `publish text config: ${why(config)}`);
  const history = await readCommitMessages(sourceRepo, base, deps.git);
  const convention = 'value' in history ? detectConvention(history.value) : null;
  const ctx = {
    config: config.value,
    convention,
    localRoots: [deps.coreHome, copyDir, sourceRepo],
  };
  let got;
  try {
    got = await composeUnit(
      copyDir,
      branch,
      base,
      {
        unitMessage: unitMessageOf(task, u.unitId),
        sieve: (text) => sieveText('commit', text, ctx),
        convention,
      },
      deps.git,
    );
  } catch (error) {
    return stop('compose-failed', error instanceof Error ? error.message : String(error));
  }
  const head = await treeRows(copyDir, got.head, deps.git);
  if (!('value' in head)) return stop('compose-unknown', `composed tree: ${why(head)}`);
  // Хук коммита проекта поправил файлы, или сборка потеряла несохранённое — не то дерево.
  if (treeFp(head.value) !== fp)
    return stop('compose-tree-moved', 'the composed commit tree is not the gated tree: gate again');
  task.append({
    kind: 'publish.composed',
    actor: 'core',
    unitId: u.unitId,
    data: { unitId: u.unitId, compositionId, treeFp: fp, shape: got.shape, commits: got.commits },
  });
  return { ok: true };
}
