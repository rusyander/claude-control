import { Stack } from '@shared/ui/stack';
import { GroupsDefaultsCard } from './GroupsDefaultsCard';
import { GroupsProjectCard } from './GroupsProjectCard';

/**
 * Раздел «Группы»: одно место для работы с разделением. Сверху — общие
 * правила, снизу — проект, который их переопределяет. Хранит всё сервер:
 * группы работают без браузера, и решать за них по вкладке нельзя.
 */
export function GroupsTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <GroupsDefaultsCard />
      <GroupsProjectCard />
    </Stack>
  );
}
