import type { EntityRef, Group, GroupMember } from '@claude-control/contracts';
import { readHooks } from './hooks.ts';
import {
  applyEntityStates,
  rewriteHooks,
  type EntityState,
  type EntityToggleDeps,
} from './entity-toggle.ts';
import { applyGroupEnv, existingEnvKeys } from './env.ts';
import { collectLeafMembers } from './group-graph.ts';
import { compileScenarioHooks } from './group-scenario.ts';

/**
 * Включение и выключение группы целиком.
 *
 * Вынесено из маршрута ровно по той причине, по которой когда-то был вынесен
 * `entity-toggle.ts`: путей стало два — тумблер в интерфейсе и автоматическое
 * включение при работе в привязанном проекте. Разойдись эти пути хоть в одном
 * шаге, группа включалась бы сама не так, как её включает человек, и разницу
 * никто бы не увидел до первого расследования.
 */

export interface GroupToggleResult {
  /** Сколько участников реально переключено (без пропущенных локальных хуков). */
  affected: number;
  skippedLocalHooks: number;
  backupPath?: string;
}

/**
 * Переключатель группы. Выключение гасит все её участники разом — ради этого
 * группы и заводят: набор правил и скиллов под задачу включается и выключается
 * одним движением.
 *
 * Групповая отметка ставится отдельно от ручной. Поэтому участник, который
 * человек выключил сам, не оживёт при включении группы, а участник двух групп
 * оживёт только когда его отпустят обе.
 */
export function setGroupEnabled(
  deps: EntityToggleDeps,
  group: Group,
  isEnabled: boolean,
): GroupToggleResult {
  const { paths, store } = deps;

  store.saveGroup({ ...group, isEnabled });

  // Разворачиваем вложенные группы: гасим/зажигаем и потомков по всей ветке,
  // а не только прямых участников. Отметка «погашено этой группой» ставится
  // от id переключаемой группы — так лист, входящий ещё и в другую группу,
  // оживает лишь когда его отпустят все.
  const leaves = collectLeafMembers(store.getGroups(), group.members);

  // Хук из settings.local.json группе не подчиняется: панель в этот файл не
  // пишет, поэтому выключить его нечем — и `readHooks` честно показывает его
  // включённым. Раньше отметка всё равно ставилась: группа рапортовала «N
  // выключено», а личный хук продолжал срабатывать. Теперь такие участники
  // пропускаются и считаются отдельно, чтобы интерфейс сказал правду.
  const localHookIds = new Set(
    readHooks(paths.settings, store, paths.settingsLocal)
      .filter((hook) => hook.source === 'settings-local')
      .map((hook) => hook.id),
  );

  let skippedLocalHooks = 0;

  // Сначала отметки — они и решают итог для каждого участника, — и только
  // потом одна запись на файл. Раньше отметка и запись шли вперемешку по
  // участникам, и общий файл переписывался столько раз, сколько в группе
  // участников.
  const states: EntityState[] = [];

  for (const member of leaves) {
    if (member.kind === 'hook' && localHookIds.has(member.id)) {
      skippedLocalHooks += 1;
      continue;
    }

    store.setGroupDisabled(member.kind, member.id, group.id, !isEnabled);
    states.push({
      kind: member.kind,
      id: member.id,
      isEnabled: !store.isDisabled(member.kind, member.id),
    });
  }

  const { needsHookRewrite } = applyEntityStates(deps, states);

  // Хуки лежат в одном файле, поэтому перезапись одна на всю группу.
  const hookBackup = needsHookRewrite ? rewriteHooks(deps) : undefined;
  // Переменные окружения группы: включение пишет их в settings.json,
  // выключение — снимает свои, не задев ручные и общие с другой группой.
  const envBackup = applyGroupEnvState(deps, group, isEnabled);

  // Триггер сценария принадлежит включённой группе: выключенная не должна
  // ничего навязывать. Пересборка идёт ЗДЕСЬ, а не в маршруте, потому что
  // тумблер щёлкает не только человек — привязка к проекту включает группу
  // сама, и сценарий обязан появиться и в этом случае.
  compileScenarioHooks(deps);

  return {
    affected: leaves.length - skippedLocalHooks,
    skippedLocalHooks,
    backupPath: hookBackup ?? envBackup,
  };
}

/**
 * Отпустить участников удаляемой группы: её отметки должны уйти вместе с ней,
 * иначе участники остались бы погашенными навсегда, без видимой причины.
 */
export function releaseGroupMembers(deps: EntityToggleDeps, group: Group): void {
  const { store } = deps;
  const states: EntityState[] = [];

  for (const member of collectLeafMembers(store.getGroups(), group.members)) {
    store.setGroupDisabled(member.kind, member.id, group.id, false);
    states.push({
      kind: member.kind,
      id: member.id,
      isEnabled: !store.isDisabled(member.kind, member.id),
    });
  }

  applyEntityStates(deps, states);
  rewriteHooks(deps);
}

/** Совпадают ли наборы env двух версий группы (одни ключи и значения). */
export function sameEnv(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/**
 * Применить или снять переменные окружения группы в settings.json.
 *
 * Включение: пишем ключи группы, но пропускаем те, что уже заданы вручную (есть
 * в settings и не принадлежат ни одной группе) — ручная переменная важнее. Что
 * реально записали, запоминаем за группой.
 *
 * Выключение: снимаем только свои ключи и только те, что больше не держит ни
 * одна другая группа. Поэтому ручные и общие с другой группой ключи остаются.
 */
export function applyGroupEnvState(
  deps: EntityToggleDeps,
  group: Group,
  isEnabled: boolean,
): string | undefined {
  const { paths, store, backupDir } = deps;
  const settingsPath = paths.settings;

  if (isEnabled) {
    const manual = new Set(
      existingEnvKeys(settingsPath).filter((key) => !store.isEnvKeyOwnedByGroup(key)),
    );
    const set: Record<string, string> = {};
    const applied: string[] = [];
    for (const [key, value] of Object.entries(group.env ?? {})) {
      if (manual.has(key)) continue;
      set[key] = value;
      applied.push(key);
    }
    store.setGroupEnvKeys(group.id, applied);
    return Object.keys(set).length ? applyGroupEnv(settingsPath, set, [], backupDir) : undefined;
  }

  const owned = store.getGroupEnvKeys(group.id);
  store.setGroupEnvKeys(group.id, []);
  const remove = owned.filter((key) => !store.isEnvKeyOwnedByGroup(key));
  return remove.length ? applyGroupEnv(settingsPath, {}, remove, backupDir) : undefined;
}

/**
 * Привести отметки «погашено этой группой» к новому составу после правки.
 *
 * Ушедший из группы участник освобождается от её удержания: снимаем отметку
 * этой группы, и если сущность больше не держит ни другая группа, ни ручное
 * выключение — она оживает на диске (как будто участник вышел из группы).
 * Пришедший в ВЫКЛЮЧЕННУЮ группу участник, симметрично, гасится ею.
 *
 * На диск ходим только когда итог реально сменился — иначе каждая правка имени
 * включённой группы дёргала бы перезапись файлов и плодила резервные копии.
 * Хуки лежат в одном файле, поэтому перезапись одна на всю правку.
 */
export function reconcileMembers(
  deps: EntityToggleDeps,
  group: Group,
  previousMembers: GroupMember[],
): void {
  const { store } = deps;
  // Разделитель — двоеточие, а не байт NUL: из-за NUL git и ripgrep считали
  // этот файл двоичным и молча пропускали его при поиске по репозиторию. Ключ
  // только сравнивается и никогда не разбирается обратно, а `kind` — значение
  // закрытого перечисления без двоеточия, поэтому склейка остаётся однозначной.
  const keyOf = (member: EntityRef): string => `${member.kind}:${member.id}`;
  // Сравниваем не прямой состав, а развёрнутые листья: правка вложенной группы
  // добавляет/убирает всех её потомков, и отметки удержания должны идти за ними.
  const groups = store.getGroups();
  const nextLeaves = collectLeafMembers(groups, group.members);
  const previousLeaves = collectLeafMembers(groups, previousMembers);

  const nextKeys = new Set(nextLeaves.map(keyOf));
  const prevKeys = new Set(previousLeaves.map(keyOf));

  const removed = previousLeaves.filter((member) => !nextKeys.has(keyOf(member)));
  const added = nextLeaves.filter((member) => !prevKeys.has(keyOf(member)));

  const states: EntityState[] = [];

  const reapply = (member: EntityRef, heldByGroup: boolean): void => {
    const before = store.isDisabled(member.kind, member.id);
    store.setGroupDisabled(member.kind, member.id, group.id, heldByGroup);
    const after = store.isDisabled(member.kind, member.id);
    if (before !== after) states.push({ kind: member.kind, id: member.id, isEnabled: !after });
  };

  for (const member of removed) reapply(member, false);
  if (!group.isEnabled) for (const member of added) reapply(member, true);

  const { needsHookRewrite } = applyEntityStates(deps, states);
  if (needsHookRewrite) rewriteHooks(deps);
}
