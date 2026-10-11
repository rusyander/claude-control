import { Stack } from '@shared/ui/stack';
import { MobileApkCard } from '../MobileApkCard/MobileApkCard';
import { OutsideRelayCard } from '../OutsideRelayCard/OutsideRelayCard';

/**
 * Раздел «Телефон»: само приложение (собрать, поставить, скачать) и вопросы
 * агента с компьютера на телефон. Спаривание и доступ снаружи остаются в
 * «Доступе» — там вопрос «кому что открыто», здесь — «что телефон умеет».
 */
export function PhoneTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <MobileApkCard />
      <OutsideRelayCard />
    </Stack>
  );
}
