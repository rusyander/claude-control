import type { Group } from '@agentdeck/contracts';
import type {
  GroupKey,
  PairChoices,
  StoredProjectChoice,
} from '@agentdeck/contracts/group-sources';
import {
  effectivePairSide,
  groupKeyOf,
  inClaudeGlobals,
  pairChoiceOf,
  pairsOf,
  parseGroupKey,
  scopeOf,
  scopeProvider,
  type GroupPairOf,
} from '@agentdeck/contracts/group-sources';
import {
  projectKey,
  readGroupSources,
  updateGroupSources,
} from '../../lib/app-store/group-sources.ts';
import { GroupRequestError } from './errors.ts';

/**
 * Выбор группы пары в проекте: проектная (то, что проект несёт сам) или её
 * глобальная копия. Инвариант — в каждой паре действует ОДНА: две сразу значили
 * бы два порядка работы на одну задачу, и выбирала бы между ними модель.
 *
 * Пара — глобальная группа с `origin.groupId` проектной. Выбора нет — действует
 * проектная: проект уже несёт её файлы, и считать иначе значило бы молча
 * отменить то, что лежит в его репозитории. Выбор хранится у каждой пары свой
 * (F-113): один слот на проект возвращал первую пару к проектной, стоило выбрать
 * глобальную сторону второй или скопировать вторую группу.
 *
 * Сами правила пары — в контрактах (`pairsOf`, `effectivePairSide`): меню чата
 * в браузере прячет неактивную сторону той же функцией, что и каталог разбора.
 */

export type GroupPair = GroupPairOf<Group>;

/** Пары проекта: его проектные группы и их глобальные копии. */
export function pairsIn(groups: readonly Group[], path: string): GroupPair[] {
  const key = projectKey(path);
  return pairsOf(groups, (scopePath) => projectKey(scopePath) === key);
}

/** Действующая группа пары в проекте: выбор человека или проектная. */
export function effectiveChoice(choice: StoredProjectChoice | null, pair: GroupPair): GroupKey {
  return effectivePairSide(choice, pair);
}

/**
 * Выбор каждой пары проекта картой. Запись v1 (строка) раскладывается на пару,
 * чью сторону называет; выборы групп, которых больше нет, отпадают.
 */
export function pairChoicesOf(
  stored: StoredProjectChoice | null | undefined,
  pairs: readonly GroupPair[],
): PairChoices {
  const out: PairChoices = {};
  for (const pair of pairs) {
    const choice = pairChoiceOf(stored, pair);
    if (choice) out[pair.project.id] = choice;
  }
  return out;
}

/**
 * Поставить выбор одной пары в состояние проекта: остальные пары остаются как
 * были (строка v1 при этом становится картой). Для копии и для переключателя.
 */
export function withPairChoice(
  stored: StoredProjectChoice | null | undefined,
  pairs: readonly GroupPair[],
  pair: GroupPair,
  groupKey: GroupKey,
): PairChoices {
  return { ...pairChoicesOf(stored, pairs), [pair.project.id]: groupKey };
}

/** Пара проекта, одну из сторон которой называет ключ. */
function pairNamed(pairs: readonly GroupPair[], groupKey: GroupKey): GroupPair | undefined {
  return pairs.find(
    (pair) =>
      groupKeyOf(pair.project) === groupKey ||
      (pair.global && groupKeyOf(pair.global) === groupKey),
  );
}

/**
 * Вторая копия той же проектной группы запрещена: пара берёт ПЕРВУЮ глобальную
 * с этим origin, и выбор, поставленный на вторую, откатывал проект к проектной.
 * Обновить копию — слияние с оригиналом, а не новая копия.
 */
export function assertNotCopied(
  groups: readonly Group[],
  source: Group,
  provider = 'claude',
): void {
  // Копия для другой CLI — своя запись в её каталогах: копия в Claude рядом с
  // ней не вторая, пара берёт только глобальную группу Claude.
  const copied = (group: Group): boolean => {
    const scope = scopeOf(group);
    return scope.kind === 'global' && scopeProvider(scope) === provider;
  };
  if (groups.some((group) => copied(group) && group.origin?.groupId === source.id)) {
    throw new GroupRequestError(409, 'group_already_copied', 'group-already-copied');
  }
}

const bothActive = (): GroupRequestError =>
  new GroupRequestError(409, 'group_pair_both_active', 'group-pair-both-active');

/** Привязана ли глобальная группа к проекту (включается сама при работе в нём). */
function boundTo(group: Group, path: string): boolean {
  const key = projectKey(path);
  return (group.projectPaths ?? []).some((item) => projectKey(item) === key);
}

/**
 * Не оставит ли выбор `groupKey` в проекте обе группы пары. Проектная выбрана,
 * а глобальная копия привязана к тому же проекту — обе действуют: привязка
 * включит копию при первом же чате. Отказ, а не молчаливое снятие привязки:
 * её ставил человек, и решать, какая из двух правок главнее, ему.
 */
export function assertChoiceKeepsPair(
  groups: readonly Group[],
  path: string,
  choice: StoredProjectChoice | null,
): void {
  for (const pair of pairsIn(groups, path)) {
    if (!pair.global) continue;
    if (effectiveChoice(choice, pair) === groupKeyOf(pair.project) && boundTo(pair.global, path))
      throw bothActive();
  }
}

/**
 * Правка глобальной группы (PUT) не должна привязать её к проекту, где
 * действует её проектный оригинал.
 */
export function assertBindingKeepsPair(
  appData: string,
  groups: readonly Group[],
  next: Group,
): void {
  if (!next.origin || !inClaudeGlobals(next.scope)) return;
  const origin = next.origin.scope;
  if (origin.kind !== 'project' || !boundTo(next, origin.path)) return;
  const choice = readGroupSources(appData).choices[projectKey(origin.path)] ?? null;
  const project = groups.find((group) => group.id === next.origin?.groupId);
  if (!project) return;
  if (effectiveChoice(choice, { project, global: next }) === groupKeyOf(project)) {
    throw bothActive();
  }
}

/** Выбор проекта как лежит в `group-sources.json` (строка — запись v1). */
export function readChoice(appData: string, path: string): StoredProjectChoice | null {
  return readGroupSources(appData).choices[projectKey(path)] ?? null;
}

/** Выбор каждой пары проекта картой — для ответа клиенту. */
export function readPairChoices(
  appData: string,
  groups: readonly Group[],
  path: string,
): PairChoices {
  return pairChoicesOf(readChoice(appData, path), pairsIn(groups, path));
}

/**
 * Записать выбор. Ключ называет сторону ОДНОЙ пары, и меняется выбор только её;
 * `null` снимает выбор всех пар проекта. Ключ группы, которая не сторона пары
 * этого проекта, — отказ: записать его было бы некуда, а молча принять — солгать.
 */
export function writeChoice(
  appData: string,
  groups: readonly Group[],
  path: string,
  groupKey: GroupKey | null,
): GroupKey | null {
  const pairs = pairsIn(groups, path);
  if (!groupKey) {
    assertChoiceKeepsPair(groups, path, null);
    updateGroupSources(appData, (state) => {
      delete state.choices[projectKey(path)];
    });
    return null;
  }
  const parsed = parseGroupKey(groupKey);
  if (!parsed || !groups.some((group) => group.id === parsed.id)) {
    throw new GroupRequestError(404, 'group_not_found', 'group-not-found');
  }
  const pair = pairNamed(pairs, groupKey);
  if (!pair) throw new GroupRequestError(409, 'group_not_paired', 'group-not-paired');
  updateGroupSources(appData, (state) => {
    const key = projectKey(path);
    const next = withPairChoice(state.choices[key], pairs, pair, groupKey);
    assertChoiceKeepsPair(groups, path, next);
    state.choices[key] = next;
  });
  return groupKey;
}
