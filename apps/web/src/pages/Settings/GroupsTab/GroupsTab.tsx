import { Stack } from '@shared/ui/stack';
import { GroupsDefaultsCard } from '../GroupsDefaultsCard/GroupsDefaultsCard';
import { GroupsProjectCard } from '../GroupsProjectCard/GroupsProjectCard';
import { SievesCard } from '../SievesCard/SievesCard';

/**
 * Раздел «Группы»: одно место для работы с разделением. Сверху — общие
 * правила, ниже — проект, который их переопределяет, и сита перед MR. Хранит всё сервер:
 * группы работают без браузера, и решать за них по вкладке нельзя.
 */
export function GroupsTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <GroupsDefaultsCard />
      <GroupsProjectCard />
      <SievesCard />
    </Stack>
  );
}
