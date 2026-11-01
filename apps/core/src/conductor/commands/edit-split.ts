import {
  afterAccept,
  deliverableOf,
  latestSplit,
  linesOf,
  proposeSplit,
  repoKeyFor,
  reviewTargetsOf,
} from '../split/index.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/** Единица правки, как её разобрала схема `edit-split` (контракт команд). */
interface UnitEdit {
  name: string;
  ownedPaths: string[];
  deps: string[];
  repo: string | null;
  contract: boolean;
}

/**
 * Правка деления человеком (02:69): новое предложение (`split.proposed by human`) взамен
 * последнего, та же проверка (P39), что у плана, — правка человека не обходит ни пересечение
 * путей, ни цикл. Прошла — `edited`, дальше политика запуска как у принятого. Не прошла —
 * команда отвергнута с каждой проблемой; последним делением становится отвергнутое, и запуск
 * его не возьмёт, пока человек не поправит снова (тихий откат к прежнему скрыл бы отказ).
 */
export const applyEditSplit: ApplyCommand = async (task, command, cmdEnv) => {
  const { cmdId } = command;
  // Поля уже разобраны схемой вида при приёме (`parseCommand`).
  const { splitId, units } = command.fields as unknown as { splitId: string; units: UnitEdit[] };
  const env = cmdEnv.split();
  if (!env) return reject(task, cmdId, 'preflight-unwired', 'split environment is not wired');
  const lines = linesOf(task);
  const latest = latestSplit(lines);
  const missing: string[] = [];
  if (task.state.task !== 'estimating' && task.state.task !== 'awaiting-launch')
    missing.push(`task is ${task.state.task}: a split is edited only before launch`);
  if (latest?.splitId !== splitId) missing.push(`split ${splitId} is not the latest split`);
  if (missing.length > 0)
    return { ...reject(task, cmdId, 'state-conflict', missing.join('; ')), state: task.state };
  const repos = task.state.created?.repos ?? [];
  const proposed = units.map((u) => ({
    name: u.name,
    repoKey: repoKeyFor(u.repo, repos),
    ownedPaths: [...u.ownedPaths],
    deps: [...u.deps],
    contract: u.contract,
    estimate: { minutes: null, tokens: null },
  }));
  const targets = reviewTargetsOf(lines);
  const scenarioId = task.state.created?.scenario.id ?? '';
  const outcome = proposeSplit(
    task,
    proposed,
    { by: 'human', stepId: null, cmdId },
    { deliverable: deliverableOf(scenarioId, targets ? targets.length : null) },
    env,
  );
  if (outcome.decision.verdict !== 'accepted')
    return reject(task, cmdId, 'split-refused', outcome.decision.reasons.join('; '));
  const after = await afterAccept(task, outcome, env);
  return applied(task, cmdId, { splitId: outcome.splitId, then: after.kind });
};
