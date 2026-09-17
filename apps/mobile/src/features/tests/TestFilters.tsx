import { StyleSheet, View } from 'react-native';
import type { ProjectTestCase, ProjectTestPriority, ProjectTestStatus } from '@agentdeck/contracts';
import { Chips, Muted } from '../../shared/ui';
import { space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';

/**
 * Отбор кейсов на телефоне: статус, важность, метка.
 *
 * Только эти три, хотя в формате полей вдвое больше. Причина — вопрос, с
 * которым открывают экран в руке: «что сейчас красное», «что обязательно
 * прогнать», «что относится к этой части». Остальные срезы (готовность, тип,
 * автоматизация, секции) остаются панели, где есть место под таблицу.
 *
 * Метки берутся из самой группы, а не из общего словаря: чужая метка в списке
 * фильтров означала бы отбор, который всегда даёт пусто.
 */
export interface TestFilterState {
  status: ProjectTestStatus | '';
  priority: ProjectTestPriority | '';
  tag: string;
}

export const EMPTY_FILTER: TestFilterState = { status: '', priority: '', tag: '' };

export function isFilterEmpty(filter: TestFilterState): boolean {
  return !filter.status && !filter.priority && !filter.tag;
}

export function filterCases(cases: ProjectTestCase[], filter: TestFilterState): ProjectTestCase[] {
  return cases.filter((item) => {
    if (filter.status && item.status !== filter.status) return false;
    if (filter.priority && item.priority !== filter.priority) return false;
    if (filter.tag && !(item.tags ?? []).includes(filter.tag)) return false;
    return true;
  });
}

/** Метки, которые вообще встречаются в этой группе. */
export function tagsOf(cases: ProjectTestCase[]): string[] {
  const found = new Set<string>();
  for (const item of cases) for (const tag of item.tags ?? []) found.add(tag);
  return [...found].sort();
}

export function TestFilters({
  cases,
  filter,
  onChange,
}: {
  cases: ProjectTestCase[];
  filter: TestFilterState;
  onChange: (filter: TestFilterState) => void;
}) {
  const t = useT();
  const tags = tagsOf(cases);

  return (
    <View style={styles.root}>
      <Muted>{t.tests.filter.title}</Muted>
      <Chips<ProjectTestStatus | ''>
        value={filter.status}
        onChange={(status) => onChange({ ...filter, status })}
        options={[
          { value: '', label: t.tests.filter.any },
          { value: 'failed', label: t.tests.status.failed },
          { value: 'passed', label: t.tests.status.passed },
          { value: 'unknown', label: t.tests.status.unknown },
          { value: 'skipped', label: t.tests.status.skipped },
          { value: 'blocked', label: t.tests.status.blocked },
        ]}
      />
      <Chips<ProjectTestPriority | ''>
        value={filter.priority}
        onChange={(priority) => onChange({ ...filter, priority })}
        options={[
          { value: '', label: t.tests.filter.any },
          { value: 'blocker', label: t.tests.priority.blocker },
          { value: 'high', label: t.tests.priority.high },
          { value: 'medium', label: t.tests.priority.medium },
          { value: 'low', label: t.tests.priority.low },
        ]}
      />
      {tags.length > 0 ? (
        <Chips<string>
          value={filter.tag}
          onChange={(tag) => onChange({ ...filter, tag })}
          options={[
            { value: '', label: t.tests.filter.anyTag },
            ...tags.map((tag) => ({ value: tag, label: `#${tag}` })),
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.xs },
});
