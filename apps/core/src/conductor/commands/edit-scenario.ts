import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import type { z } from 'zod';
import {
  diffScenarios,
  isPresetId,
  latestTaskScenario,
  latestVersion,
  listLibrary,
  planScenarioEdit,
  presetOf,
  readLibraryScenario,
  resolveScenario,
  scenarioPrecedence,
  writeLibraryScenario,
  type ScenarioDiff,
} from '../scenario/index.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { riskyOf } from '../../policy/resolve/risky.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Правка сценария (G11, P70): новая версия целиком пишется в библиотеку один раз, затем строка
 * `scenario.edited` с разницей. Идущий шаг остаётся на своей версии; новая действует со
 * следующего шага, а «применить сейчас» — с ближайшей безопасной точки (`scenarioForStep`).
 * Отказ называет все невыполненные условия сразу.
 */

type Fields = z.infer<(typeof COMMAND_FIELDS)['edit-scenario']>;

/** Основа для разницы: пресет из кода или версия из библиотеки; не прочлась — разница не известна. */
async function baseScenario(dir: string, ref: ScenarioRef): Promise<Scenario | string> {
  if (isPresetId(ref.id)) return presetOf(ref) ?? `preset ${ref.id}@${ref.version} is unknown`;
  const read = await readLibraryScenario(dir, ref);
  if (read.kind === 'value') return read.scenario;
  return read.kind === 'absent' ? 'base is not in the library' : `${read.kind}: ${read.reason}`;
}

export const applyEditScenario: ApplyCommand = async (task, command, env) => {
  const fields = command.fields as Fields;
  const { cmdId } = command;
  const fold = task.state.scenario;
  if (!fold || task.state.ended)
    return reject(
      task,
      cmdId,
      'state-conflict',
      fold ? `task already ended (${task.state.ended})` : 'task has no scenario yet',
    );
  // Библиотека — в доме ядра из среды команды, а не выведена из пути задачи.
  const dir = env.layout.scenarios;
  const listing = await listLibrary(dir);
  if ('unknown' in listing)
    return reject(task, cmdId, 'library-unreadable', `scenario library: ${listing.unknown}`);
  const current = latestTaskScenario(fold);
  const plan = planScenarioEdit(current, latestVersion(listing.value, fields.scenario.id), fields);
  if (!plan.ok) return reject(task, cmdId, plan.code, plan.reasons.join('; '));
  const written = await writeLibraryScenario(dir, fields.scenario);
  if ('refused' in written) return reject(task, cmdId, written.refused, written.reason);
  const base = await baseScenario(dir, current);
  const diff: ScenarioDiff =
    typeof base === 'string'
      ? { added: [], removed: [], changed: [], title: false, baseUnread: base }
      : diffScenarios(base, fields.scenario);
  task.append({
    kind: 'scenario.edited',
    actor: 'core',
    cmdId,
    data: { cmdId, from: current, to: plan.to, diff: { ...diff }, applyNow: fields.applyNow },
  });
  // Живое решение (уровень 2) расширять вправе, но рискованное — одно предупреждение (06:8-9).
  const warnings =
    typeof base === 'string'
      ? []
      : riskyOf({ kind: 'edit-scenario', before: base, after: fields.scenario });
  // Новая версия поверх файлов проекта — то же решение старшинства, что дадут оценка и деление (P80).
  const created = task.state.created;
  if (created) {
    const got = await resolveScenario(plan.to, created.repos, { libraryDir: dir });
    if (got.ok) {
      task.append({
        kind: 'decision',
        actor: 'core',
        cmdId,
        data: {
          decisionId: newId(),
          ...scenarioPrecedence(got, {
            routes: allowedRoutesOf(task.state),
            level: created.routesSourceLevel,
          }),
        },
      });
    } else {
      warnings.push(
        `${plan.to.id}@${plan.to.version} does not resolve over the project files: ` +
          got.refusals.map((r) => `${r.source}: ${r.reason}`).join('; '),
      );
    }
  }
  return applied(task, cmdId, {
    from: `${current.id}@${current.version}`,
    to: `${plan.to.id}@${plan.to.version}`,
    applies: fields.applyNow ? 'next-safe-point' : 'next-step',
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};
