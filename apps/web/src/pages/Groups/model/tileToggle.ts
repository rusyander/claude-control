import type { GroupScope, GroupsModel } from '@agentdeck/contracts';
import { isForeignGlobal, scopeProvider } from '@agentdeck/contracts';

/** Тумблер карточки: показан ли, в каком положении и чей (`provider` для записи). */
export interface TileToggle {
  shown: boolean;
  checked: boolean;
  /** CLI, чьё положение двигает тумблер; нет — каталоги Claude. */
  provider?: string;
}

/**
 * Чей тумблер на карточке — решает активный CLI, как и сервер
 * (`POST /api/groups/:id/enabled`). Группа Claude при CLI со слоем
 * включается для ЭТОГО CLI (`enabledFor`, F1 владельца 06.10): показывать ей
 * `isEnabled` значило бы рисовать положение Claude, а щелчок двигал бы другое.
 * У CLI без слоя группа не действует (сервер ответил бы 409) — тумблера нет,
 * причину называет строка над сеткой. Копия для другой CLI держит её файлы —
 * тумблер общих сущностей Claude её не касается.
 */
export function tileToggle(
  group: { isEnabled: boolean; scope?: GroupScope; enabledFor?: Record<string, boolean> },
  provider: { id: string; groupsModel?: GroupsModel } | undefined,
): TileToggle {
  if (isForeignGlobal(group.scope)) return { shown: false, checked: false };
  const claudeFiles =
    !provider || provider.id === 'claude' || scopeProvider(group.scope) !== 'claude';
  if (claudeFiles) return { shown: true, checked: group.isEnabled };
  if (provider.groupsModel !== 'run-layer') return { shown: false, checked: false };
  return { shown: true, checked: group.enabledFor?.[provider.id] === true, provider: provider.id };
}
