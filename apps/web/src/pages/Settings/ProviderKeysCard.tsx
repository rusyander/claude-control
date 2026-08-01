import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderKeys } from '@entities/ProviderKeys';
import { ProviderKeyRow } from './ProviderKeyRow';

/**
 * Блок «API-ключи провайдеров» в настройках (Ф6a).
 *
 * По каждому провайдеру с собственным модельным API: тип API (apiKind), статус
 * ключа (задан в панели / найден в окружении: <ENV_VAR> / нет) и поле ввода
 * (masked) с кнопками сохранить/очистить. Ключ уходит на сервер и хранится
 * зашифрованно; наружу возвращается только маска — само значение здесь никогда
 * не показывается. Провайдеры без модельного API (Cursor) в списке не участвуют.
 */
export function ProviderKeysCard() {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderKeys();

  if (isLoading || !data) return <SkeletonList rows={3} withActions={false} />;

  const keyable = data.items.filter((item) => item.supported);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('providerKeys.title')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('providerKeys.hint')}
          </Typography>
        </Stack>

        <Stack gap="var(--spacing-sm)">
          {keyable.map((item) => (
            <ProviderKeyRow key={item.providerId} item={item} />
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
