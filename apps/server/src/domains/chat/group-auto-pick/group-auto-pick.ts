import type { Group } from '@agentdeck/contracts';
import {
  effectivePairSide,
  groupKeyOf,
  inactivePairSides,
  parseGroupKey,
  type GroupKey,
  type StoredProjectChoice,
} from '@agentdeck/contracts/group-sources';
import { pairsIn, readChoice } from '../../groups/choice/choice.ts';
import { layoutForCwd } from '../../project-git/copy-readiness.ts';
import { isSandboxPath } from '../ChatArtifacts/ChatArtifacts.ts';

/**
 * Закреплённая группа разговора, сверенная с парами проекта прогона.
 *
 * Каталог разбора, запись выбора разбора ребёнку и включение группы к старту
 * ушли вместе с разделением чата (этап 10: группы ведёт ядро сценарием); здесь
 * осталось одно правило, которое читает строка «чисел» группы
 * (`group-run-lines.ts`).
 */

/** Группы и выбор пар проекта В МОМЕНТ прогона — против них сверяется закрепление. */
interface PickProject {
  groups: readonly Group[];
  projectPath: string;
  pairChoice: StoredProjectChoice | null;
}

/**
 * Группа, которую чату в этом проекте закрепить нельзя: неактивная сторона пары
 * (F-107) — иначе прогон шёл бы по шагам группы, которой в проекте нет.
 */
function inactivePairPin(project: PickProject, choice: GroupKey): boolean {
  return inactivePairSides(pairsIn(project.groups, project.projectPath), project.pairChoice).has(
    choice,
  );
}

/**
 * Закрепление, сделанное, пока его сторона пары действовала, переживает смену
 * стороны: неактивная половина заменяется действующей ТОЙ ЖЕ пары — обе половины
 * одна группа (глобальная — копия проектной).
 */
function activePick(project: PickProject, groupKey: GroupKey): GroupKey {
  if (!inactivePairPin(project, groupKey)) return groupKey;
  const pair = pairsIn(project.groups, project.projectPath).find((one) =>
    [one.project, one.global].some((side) => side && groupKeyOf(side) === groupKey),
  );
  return pair ? effectivePairSide(project.pairChoice, pair) : groupKey;
}

/**
 * Выбор группы разговора, сверенный с парами проекта ПРОГОНА (F-107).
 *
 * Проект — основная копия: ребёнок разделения идёт в копии репозитория
 * (`git worktree`), а выбор стороны записан на основной проект. Без каталога, в
 * песочнице и при `auto` выбор остаётся как есть.
 */
export function pinnedChoiceAt<Choice extends string>(
  groups: readonly Group[],
  appData: string,
  choice: Choice,
  cwd: string | undefined,
): Choice | GroupKey {
  if (!cwd || isSandboxPath(cwd) || choice === 'auto' || !parseGroupKey(choice)) return choice;
  const projectPath = layoutForCwd(cwd).mainDir ?? cwd;
  return activePick(
    { groups, projectPath, pairChoice: readChoice(appData, projectPath) },
    choice as GroupKey,
  );
}
