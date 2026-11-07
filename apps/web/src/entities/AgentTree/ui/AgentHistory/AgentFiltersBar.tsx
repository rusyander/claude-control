import { useTranslation } from 'react-i18next';
import {
  AGENT_KINDS,
  AGENT_STATUSES,
  type AgentKind,
  type AgentStatus,
} from '@agentdeck/contracts/core/agents';
import { TASK_CLASSES, type TaskClass } from '@agentdeck/contracts/core/scenario';
import { SelectField, type SelectOption } from '@shared/ui/select-field';
import type { AgentFilters } from '../../model/coreAgents.types';
import type { AgentFiltersBarProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

const ALL = '';

/** Снять поле фильтра или поставить его: пустое значение — фильтра нет. */
function withField<K extends keyof AgentFilters>(
  filters: AgentFilters,
  key: K,
  value: string,
): AgentFilters {
  const next: AgentFilters = { ...filters };
  if (value === ALL) delete next[key];
  else next[key] = value as AgentFilters[K];
  return next;
}

/**
 * Фильтры окна — те же поля, что у списка ядра (состояние, модель, вид, класс задачи, группа):
 * отбирает ядро, а не экран, поэтому обрезанный пределом список всё равно показывает нужное.
 */
export function AgentFiltersBar({ filters, onChange, models, groups }: AgentFiltersBarProps) {
  const { t } = useTranslation();
  const all: SelectOption = { value: ALL, label: t('agentTree.history.filters.all') };
  const set = (key: keyof AgentFilters) => (value: string) =>
    onChange(withField(filters, key, value));

  return (
    <fieldset className={styles.filters} data-agent-filters>
      <legend className={styles.filtersLegend}>{t('agentTree.history.filters.label')}</legend>
      <SelectField
        label={t('agentTree.history.filters.status')}
        value={filters.status ?? ALL}
        onChange={set('status')}
        options={[
          all,
          ...AGENT_STATUSES.map((status: AgentStatus) => ({
            value: status,
            label: t(`agentTree.status.${status}`),
          })),
        ]}
      />
      <SelectField
        label={t('agentTree.history.filters.model')}
        value={filters.model ?? ALL}
        onChange={set('model')}
        options={[all, ...models.map((model) => ({ value: model, label: model }))]}
      />
      <SelectField
        label={t('agentTree.history.filters.kind')}
        value={filters.kind ?? ALL}
        onChange={set('kind')}
        options={[
          all,
          ...AGENT_KINDS.map((kind: AgentKind) => ({
            value: kind,
            label: t(`agentTree.kind.${kind}`),
          })),
        ]}
      />
      <SelectField
        label={t('agentTree.history.filters.class')}
        value={filters.class ?? ALL}
        onChange={set('class')}
        options={[all, ...TASK_CLASSES.map((cls: TaskClass) => ({ value: cls, label: cls }))]}
      />
      {groups.length > 0 && (
        <SelectField
          label={t('agentTree.history.filters.group')}
          value={filters.groupId ?? ALL}
          onChange={set('groupId')}
          options={[
            { value: ALL, label: t('agentTree.history.filters.groupChat') },
            ...groups.map((groupId) => ({ value: groupId, label: groupId })),
          ]}
        />
      )}
    </fieldset>
  );
}
