import type { Group } from '@agentdeck/contracts';
import {
  effectivePairSide,
  groupKeyOf,
  inClaudeGlobals,
  inactivePairSides,
  parseGroupKey,
  type GroupKey,
  type StoredProjectChoice,
} from '@agentdeck/contracts/group-sources';
import { TRIAGE_CATALOG_MAX, type TriageGroupCatalogEntry } from '@agentdeck/contracts/split-plan';
import type { AppStore } from '../../lib/app-store/store.ts';
import { pairsIn, readChoice } from '../groups/choice.ts';
import { layoutForCwd } from '../project-git/copy-readiness.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { isSandboxPath } from './ChatArtifacts.ts';
import {
  activateChosenGroup,
  chatGroupSettingsView,
  storeTreeReader,
  type ChatTreeReader,
} from './chat-autonomy.ts';

/**
 * Автовыбор группы разбором разделения (выбор группы чата — `auto`).
 *
 * Три шага, и каждый — здесь, чтобы конвейер и запуск групп спрашивали одно и
 * то же: какие группы разбор может выбрать (каталог), выбирать ли вообще
 * (явный выбор родителя сильнее разбора) и как выбор ложится ребёнку (своим
 * `groupChoice` ДО первого прогона — его подхватят включение на старте и шаги
 * «Пути»).
 */

/**
 * Группы, которые разбор может выбрать в проекте: глобальные и проектные
 * группы этого проекта, из пары — только действующая (выбор пары в проекте,
 * иначе проектная). Другая половина пары в каталог не идёт: две сразу значили
 * бы два порядка работы на одну задачу.
 */
export function pickableGroups(
  groups: readonly Group[],
  projectPath: string,
  pairChoice: StoredProjectChoice | null,
): TriageGroupCatalogEntry[] {
  const pairs = pairsIn(groups, projectPath);
  // То же правило, что прячет неактивную сторону в меню чата (контракты).
  const hidden = inactivePairSides(pairs, pairChoice);
  const project = new Set(pairs.map((pair) => groupKeyOf(pair.project)));
  return groups
    .filter((group) => {
      const key = groupKeyOf(group);
      if (hidden.has(key)) return false;
      // Глобальная копия для другой CLI держит её сущности — чату Claude не годится.
      return inClaudeGlobals(group.scope) || project.has(key);
    })
    .slice(0, TRIAGE_CATALOG_MAX)
    .map((group) => ({
      key: groupKeyOf(group),
      name: group.name,
      ...(group.when?.trim() ? { when: group.when.trim() } : {}),
      ...(group.flow === 'scenario' ? { scenario: true as const } : {}),
    }));
}

/**
 * Группа, которую чату в этом проекте закрепить нельзя: неактивная сторона пары
 * (F-107). То же правило, что прячет её из каталога разбора и из меню чата, —
 * иначе запрос в обход меню вёл бы прогон по шагам группы, которой в проекте
 * нет, а глобальную копию включал бы поверх проектной.
 */
export function inactivePairPin(
  groups: readonly Group[],
  projectPath: string,
  pairChoice: StoredProjectChoice | null,
  choice: string,
): Group | undefined {
  if (!parseGroupKey(choice)) return undefined;
  const hidden = inactivePairSides(pairsIn(groups, projectPath), pairChoice);
  if (!hidden.has(choice as GroupKey)) return undefined;
  return groups.find((group) => groupKeyOf(group) === choice);
}

/**
 * Каталог для разбора разделения, начатого в `parentChatId`; `undefined` —
 * разбор группу не выбирает: у родителя (своя или от его родителя) стоит явная
 * группа, или выбирать не из чего.
 */
export function triageGroupCatalog(input: {
  reader: ChatTreeReader;
  groups: readonly Group[];
  pairChoice: StoredProjectChoice | null;
  parentChatId: string;
  projectPath: string;
}): TriageGroupCatalogEntry[] | undefined {
  const view = chatGroupSettingsView(input.reader, [input.parentChatId]);
  if (view.groupChoice !== 'auto') return undefined;
  const catalog = pickableGroups(input.groups, input.projectPath, input.pairChoice);
  return catalog.length > 0 ? catalog : undefined;
}

/** Группы и выбор пар проекта В МОМЕНТ запуска — против них сверяется выбор разбора. */
export interface PickProject {
  groups: readonly Group[];
  projectPath: string;
  pairChoice: StoredProjectChoice | null;
}

/**
 * Выбор разбора, сверенный с парами проекта сейчас (F-107). Разбор выбирал из
 * каталога, снятого на его старте, а группа запускается позже — ждущая через
 * часы. Сменил человек за это время сторону пары — выбранная половина стала
 * неактивной. Отказом это не решается: выбор разбора — подсказка, без неё
 * группа всё равно идёт (как с выдуманным ключом), а человека у запуска нет.
 * Закрепить неактивную тоже нельзя — то же правило, что у `PUT group-settings`.
 * Поэтому ложится действующая сторона ТОЙ ЖЕ пары: обе половины — одна группа
 * (глобальная — копия проектной), и именно её каталог предложил бы сейчас.
 */
export function activePick(project: PickProject, groupKey: GroupKey): GroupKey {
  const { groups, projectPath, pairChoice } = project;
  if (!inactivePairPin(groups, projectPath, pairChoice, groupKey)) return groupKey;
  const pair = pairsIn(groups, projectPath).find((one) =>
    [one.project, one.global].some((side) => side && groupKeyOf(side) === groupKey),
  );
  return pair ? effectivePairSide(pairChoice, pair) : groupKey;
}

/**
 * Выбор разбора — своим выбором ребёнка. Пишется, только пока у ребёнка
 * действует `auto`: явный выбор (свой или родителя, поставленный, пока группа
 * ждала очереди) сильнее разбора. С `project` неактивная сторона пары
 * заменяется действующей (`activePick`). Возвращает записанный ключ; не
 * записано — `undefined`.
 */
export function writePickedGroup(
  store: Pick<
    AppStore,
    'getChatGroupSettings' | 'setChatGroupSettings' | 'getChatLink' | 'canonicalChatKey'
  >,
  chatKey: string,
  groupKey: string,
  project?: PickProject,
): GroupKey | undefined {
  if (!parseGroupKey(groupKey)) return undefined;
  if (chatGroupSettingsView(storeTreeReader(store), [chatKey]).groupChoice !== 'auto') {
    return undefined;
  }
  const picked = groupKey as GroupKey;
  const key = project ? activePick(project, picked) : picked;
  store.setChatGroupSettings(chatKey, { ...store.getChatGroupSettings(chatKey), groupChoice: key });
  return key;
}

/**
 * Выбор группы разговора, сверенный с парами проекта ПРОГОНА (F-107):
 * закрепление, сделанное, пока его сторона пары действовала, переживает смену
 * стороны, и неактивная половина заменяется действующей той же пары
 * (`activePick`). Одно правило на всех, кто читает закрепление к прогону, —
 * включение на старте, шаги «Пути», строки скиллов группы: разойдись они,
 * прогон включал бы одну половину пары, а шёл по шагам другой.
 *
 * Проект — основная копия, как у меню: ребёнок разделения идёт в копии
 * репозитория (`git worktree`), а выбор стороны записан на основной проект.
 * Без каталога, в песочнице и при `auto` выбор остаётся как есть.
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

/**
 * Действующая группа разговора (своя или от родителя) — включить к старту
 * прогона: только включить и только глобальную (`activateChosenGroup`).
 * Песочница — мимо: у неё свой каталог конфигурации, и включение правило бы
 * чужой. Возвращает имя включённой группы; уже включённая — `undefined`.
 */
export function activateEffectiveGroup(
  deps: EntityToggleDeps,
  keys: readonly string[],
  cwd: string | undefined,
): string | undefined {
  if (!cwd || isSandboxPath(cwd)) return undefined;
  const choice = chatGroupSettingsView(storeTreeReader(deps.store), keys).groupChoice;
  // Включать неактивную половину пары нельзя — глобальная копия легла бы
  // поверх действующей проектной (`pinnedChoiceAt`).
  return activateChosenGroup(
    deps,
    pinnedChoiceAt(deps.store.getGroups(), deps.paths.appData, choice, cwd),
  );
}
