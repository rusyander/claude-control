import type { GroupWatchRecord } from '@agentdeck/contracts/group-watch';
import type { AppState } from './app-store.types.ts';
import { currentParent } from './split-plans.ts';

/**
 * Срез сигналов сторожа групп (F-42): родитель разделения → номер группы →
 * сигналы. Пишет только сторож; конвейер разделения его не касается, поэтому
 * запись разделения, собранная до долгого `await`, сигналов не сотрёт. Ключ
 * родителя идёт по цепочке переездов записи (`currentParent`): сигнал, поднятый
 * ходом до переезда, ложится к записи, а не рядом с ней.
 */

/** Блок сигналов группы как есть с диска — разбирает читатель (`groupSignalsOf`). */
export function getGroupWatchSignals(
  state: AppState,
  parentChatId: string,
  groupIndex: number,
): GroupWatchRecord | undefined {
  const parent = currentParent(state, parentChatId);
  const groups = state.groupWatchSignals;
  if (!groups || !Object.hasOwn(groups, parent)) return undefined;
  const own = groups[parent];
  return own && Object.hasOwn(own, String(groupIndex)) ? own[String(groupIndex)] : undefined;
}

/** Все блоки среза: родитель → номер группы → блок. */
export function allGroupWatchSignals(
  state: AppState,
): Record<string, Record<string, GroupWatchRecord>> {
  return state.groupWatchSignals ?? {};
}

/** Записать блок группы; `undefined` — стереть, пустой родитель уходит целиком. */
export function setGroupWatchSignals(
  state: AppState,
  parentChatId: string,
  groupIndex: number,
  record: GroupWatchRecord | undefined,
): void {
  const parent = currentParent(state, parentChatId);
  const groups = { ...state.groupWatchSignals };
  const own = { ...groups[parent] };
  if (record) own[String(groupIndex)] = record;
  else delete own[String(groupIndex)];
  if (Object.keys(own).length > 0) groups[parent] = own;
  else delete groups[parent];
  state.groupWatchSignals = groups;
}
