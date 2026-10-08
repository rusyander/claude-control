import { useTranslation } from 'react-i18next';
import type { ChatGroupChoice } from '@agentdeck/contracts/chat-group-settings';
import type { GroupKey } from '@agentdeck/contracts/group-sources';
import {
  groupKeyOf,
  inactivePairSides,
  isForeignGlobal,
  pairsOf,
  scopeOf,
} from '@agentdeck/contracts/group-sources';
import { useGroups, useProjectGroupChoice } from '@entities/Group';
import { SelectField } from '@shared/ui/select-field';
import type { ChatGroupPickerProps } from './ChatGroupPicker.types';
import { samePath } from '../../../shared/lib/samePath';

/**
 * Поле «Группа» чата — одно правило отбора для чата Claude и чата чужого CLI.
 * Запись и вид настроек — у вызывающего: у меню Claude рядом тумблер
 * автономности, и две записи подряд должны видеть одна другую.
 */
export function ChatGroupPicker({ view, scopePath, hint, onChange }: ChatGroupPickerProps) {
  const { t } = useTranslation();
  const groups = useGroups();
  // Из пары «проектная — её глобальная копия» в проекте действует одна сторона;
  // другую закрепить нельзя — то же правило, что у каталога разбора на сервере
  // (F-107). Выбор не прочитался — действует проектная, как и у сервера.
  const pairChoice = useProjectGroupChoice(scopePath);
  const inactive = inactivePairSides(
    scopePath ? pairsOf(groups.data ?? [], (path) => samePath(path, scopePath)) : [],
    pairChoice.data?.choices ?? null,
  );
  const options = [
    { value: 'auto', label: t('chat.groupSettings.auto') },
    ...(groups.data ?? [])
      .filter((group) => {
        // Глобальная копия для другой CLI держит её сущности: ни чату Claude, ни
        // слою прогона чужого CLI она не годится (слой собирается из групп Claude).
        if (isForeignGlobal(group.scope)) return false;
        if (inactive.has(groupKeyOf(group))) return false;
        const scope = scopeOf(group);
        return scope.kind === 'global' || (scopePath ? samePath(scope.path, scopePath) : false);
      })
      .map((group) => ({
        value: groupKeyOf(group),
        label:
          scopeOf(group).kind === 'project'
            ? t('chat.groupSettings.projectGroup', { name: group.name })
            : group.name,
      })),
  ];
  // Выбранная группа могла исчезнуть (удалена, другой проект) — значение
  // остаётся видимым, иначе select молча показал бы «Авто», а прогон шёл бы иначе.
  // Закреплённая раньше неактивная сторона пары названа так, а не «нет в списке».
  if (!options.some((option) => option.value === view.groupChoice)) {
    const hidden = inactive.has(view.groupChoice as GroupKey)
      ? groups.data?.find((group) => groupKeyOf(group) === view.groupChoice)
      : undefined;
    options.push({
      value: view.groupChoice,
      label: hidden
        ? t('chat.groupSettings.inactivePairSide', { name: hidden.name })
        : t('chat.groupSettings.missingGroup', { key: view.groupChoice }),
    });
  }

  return (
    <SelectField
      label={t('chat.groupSettings.group')}
      value={view.groupChoice}
      onChange={(value) => onChange(value as ChatGroupChoice)}
      options={options}
      hint={hint}
    />
  );
}
