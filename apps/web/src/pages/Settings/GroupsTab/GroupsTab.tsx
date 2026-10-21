import { Stack } from '@shared/ui/stack';
import { GroupsDefaultsCard } from '../GroupsDefaultsCard/GroupsDefaultsCard';
import { GroupEconomyCard } from '../GroupEconomyCard/GroupEconomyCard';
import { GroupWatchCard } from '../GroupWatchCard/GroupWatchCard';
import { GroupsProjectCard } from '../GroupsProjectCard/GroupsProjectCard';
import { SievesCard } from '../SievesCard/SievesCard';
import { VerifyLedgerCard } from '../VerifyLedgerCard/VerifyLedgerCard';
import type { SettingsTabProps } from '../SettingsTabs.types';

/**
 * Раздел «Группы»: одно место для работы с разделением. Сверху — общие
 * правила и экономия, ниже — проект, который их переопределяет, и сита перед MR.
 * Хранит всё сервер: группы работают без браузера, и решать за них по вкладке нельзя.
 */
export function GroupsTab({ settings, patch }: SettingsTabProps) {
  return (
    <Stack gap="var(--spacing-lg)">
      <GroupsDefaultsCard />
      <GroupEconomyCard settings={settings} patch={patch} />
      <GroupWatchCard settings={settings} patch={patch} />
      <GroupsProjectCard />
      <SievesCard />
      <VerifyLedgerCard />
    </Stack>
  );
}
