import { View } from 'react-native';
import type { ProjectTestCase, ProjectTestPriority, ProjectTestStatus } from '@agentdeck/contracts';
import { Chips, Muted } from '../../../shared/ui';
import { useT } from '../../../shared/config/i18n';
import type { TestFilterState } from './TestFilters.types';
import { tagsOf } from '../tagsOf';
import { styles } from './TestFilters.styles';

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
