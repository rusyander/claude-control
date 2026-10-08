import type { MemberSources, PickerItem } from './memberCatalog.types';
import { hookLabel } from './hookLabel';

/**
 * Всё, что можно взять в группу, одним списком. Один источник и для выбора
 * участников, и для помощника формы: помощник предлагает ровно то, что
 * человек мог бы отметить сам.
 */
export function memberCatalog(sources: MemberSources, excludeGroupId?: string): PickerItem[] {
  return [
    ...sources.rules.map((item) => ({ kind: 'rule' as const, id: item.id, label: item.title })),
    ...sources.skills.map((item) => ({ kind: 'skill' as const, id: item.id, label: item.name })),
    // Хук из settings.local.json в группу не берём: панель в этот файл не пишет,
    // выключить его группой нечем — участник выглядел бы погашенным, продолжая
    // срабатывать. Уже добавленные такие участники остаются в составе, но при
    // переключении группы честно пропускаются (см. POST /groups/:id/enabled).
    ...sources.hooks
      .filter((item) => item.source !== 'settings-local')
      .map((item) => ({ kind: 'hook' as const, id: item.id, label: hookLabel(item) })),
    ...sources.servers.map((item) => ({ kind: 'mcp' as const, id: item.id, label: item.name })),
    // Право — пятый вид участника: группа снимает его из settings.json и
    // возвращает, как и остальных. Подпись — решение и шаблон, id здесь нечитаем.
    ...sources.permissions.map((item) => ({
      kind: 'permission' as const,
      id: item.id,
      label: `${item.decision} · ${item.pattern}`,
    })),
    // Себя в участники добавить нельзя — исключаем правящуюся группу из списка.
    ...sources.groups
      .filter((item) => item.id !== excludeGroupId)
      .map((item) => ({ kind: 'group' as const, id: item.id, label: item.name })),
  ];
}
