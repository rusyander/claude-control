import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { CoreRefusal } from './coreRefusal';

/**
 * Строка отказа ядра в ленте `/chat` (W3-17a): чем ядро отказало запуску CLI этого чата — словами
 * и кодом. Стоит на месте композера: писать в такой чат нечего, начать другой — «Новый чат».
 */
export function CoreRefusalLine({ refusal }: { refusal: CoreRefusal }) {
  const { t } = useTranslation();
  return (
    <Stack padding="var(--spacing-sm) var(--spacing-xl)" role="alert">
      <Typography color="danger" data-core-chat-launch-refused={refusal.key}>
        {t(`coreChat.launchRefused.${refusal.key}`, refusal.params)}
      </Typography>
    </Stack>
  );
}
