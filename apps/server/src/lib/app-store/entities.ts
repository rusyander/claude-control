import type { EntityKind } from '@claude-control/contracts';
import type { AppState } from './app-store.types.ts';

/**
 * Итоговое состояние: выключено вручную либо погашено хотя бы одной группой.
 *
 * `legacyId` — прежний идентификатор той же сущности. Хуки перешли с
 * позиционных id на контентные, и без этой сверки все отметки, сделанные до
 * перехода, разом перестали бы находиться: выключенные хуки включились бы
 * сами собой.
 */
export function isDisabled(
  state: AppState,
  kind: EntityKind,
  id: string,
  legacyId?: string,
): boolean {
  return (
    isDisabledManually(state, kind, id) ||
    disablingGroups(state, kind, id).length > 0 ||
    (legacyId !== undefined &&
      (isDisabledManually(state, kind, legacyId) ||
        disablingGroups(state, kind, legacyId).length > 0))
  );
}

export function isDisabledManually(state: AppState, kind: EntityKind, id: string): boolean {
  return state.disabled[kind].includes(id);
}

/** Какие именно группы сейчас гасят сущность — нужно интерфейсу и логике включения. */
export function disablingGroups(state: AppState, kind: EntityKind, id: string): string[] {
  return state.disabledByGroup[kind][id] ?? [];
}

/**
 * `legacyId` убирается из отметок при любой правке: переключили сущность —
 * значит её состояние записано уже по новому идентификатору, и старая
 * запись только копила бы мусор и мешала бы включению.
 */
export function setEnabled(
  state: AppState,
  kind: EntityKind,
  id: string,
  isEnabled: boolean,
  legacyId?: string,
): void {
  const list = state.disabled[kind];

  if (legacyId) {
    const stale = list.indexOf(legacyId);
    if (stale >= 0) list.splice(stale, 1);
  }

  const index = list.indexOf(id);
  if (isEnabled && index >= 0) list.splice(index, 1);
  if (!isEnabled && index < 0) list.push(id);
}

/**
 * Перенести все отметки сущности со старого идентификатора на новый — при
 * переименовании (у скилла id = имя папки). Трогаем каждое место, где id
 * участвует: ручное выключение, гашение группой и состав групп. Иначе после
 * смены папки отметки остались бы висеть на несуществующем id.
 *
 * Возвращает `false`, когда переименовывать нечего — тогда и файл состояния
 * трогать незачем.
 */
export function renameEntity(
  state: AppState,
  kind: EntityKind,
  oldId: string,
  newId: string,
): boolean {
  if (oldId === newId) return false;

  const disabled = state.disabled[kind];
  const at = disabled.indexOf(oldId);
  if (at >= 0) {
    disabled.splice(at, 1);
    if (!disabled.includes(newId)) disabled.push(newId);
  }

  const byGroup = state.disabledByGroup[kind];
  if (byGroup[oldId]) {
    byGroup[newId] = byGroup[oldId];
    delete byGroup[oldId];
  }

  for (const group of state.groups) {
    for (const member of group.members) {
      if (member.kind === kind && member.id === oldId) member.id = newId;
    }
    // Дедупликация после переноса. Новое имя могло уже состоять в этой же
    // группе — тогда участник оказывался в составе дважды и до следующего
    // сохранения группы считался за двоих (счётчик участников, применение
    // группы, снятие гашения). Отметки `disabled` от такого же дубля
    // защищены выше — состав групп защищаем здесь.
    const seen = new Set<string>();
    group.members = group.members.filter((member) => {
      const key = `${member.kind}:${member.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return true;
}

/**
 * Забыть сущность целиком — при её удалении.
 *
 * Удаляется запись в конфиге, а её след в state.json оставался: состав групп
 * показывал участника-призрака, а `disabled`/`disabledByGroup` продолжали
 * держать отметки. Стоило завести сущность с тем же именем — она молча
 * наследовала чужие группы и могла оказаться погашенной группой, в которую
 * никогда не входила.
 *
 * Возвращает, нашлось ли что-то на самом деле: удаление сущности без единой
 * отметки не должно трогать файл состояния.
 */
export function removeEntity(state: AppState, kind: EntityKind, id: string): boolean {
  let changed = false;

  const disabled = state.disabled[kind];
  const at = disabled.indexOf(id);
  if (at >= 0) {
    disabled.splice(at, 1);
    changed = true;
  }

  const byGroup = state.disabledByGroup[kind];
  if (byGroup[id]) {
    delete byGroup[id];
    changed = true;
  }

  for (const group of state.groups) {
    const kept = group.members.filter((member) => !(member.kind === kind && member.id === id));
    if (kept.length !== group.members.length) {
      group.members = kept;
      changed = true;
    }
  }

  return changed;
}

/**
 * Отметка «эту сущность гасит вот эта группа». Пустой список удаляем целиком,
 * иначе state.json копил бы записи обо всех когда-либо выключенных группах.
 */
export function setGroupDisabled(
  state: AppState,
  kind: EntityKind,
  id: string,
  groupId: string,
  isDisabled: boolean,
): void {
  const byId = state.disabledByGroup[kind];
  const groups = new Set(byId[id] ?? []);

  if (isDisabled) groups.add(groupId);
  else groups.delete(groupId);

  if (groups.size > 0) byId[id] = [...groups];
  else delete byId[id];
}
