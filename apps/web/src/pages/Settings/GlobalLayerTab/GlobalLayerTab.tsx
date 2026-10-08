import { useTranslation } from 'react-i18next';
import { useGlobalLayer } from '@entities/GlobalLayer';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { GlobalLayerCard } from '../GlobalLayerCard/GlobalLayerCard';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Раздел «Глобальный слой» (В5): по карточке на пару «панель ↔ ~/.claude».
 * Первая выдача сама запускает сверку у пары, которую ещё не сверяли, — открыть
 * раздел и увидеть «ещё не сверяли» без кнопки было бы лишним шагом.
 */
export function GlobalLayerTab() {
  const { t } = useTranslation();
  const query = useGlobalLayer();

  if (!query.data) {
    return (
      <Typography variant="body-sm" color={query.isError ? 'danger' : 'subtle'}>
        {query.isError ? toErrorMessage(query.error) : t('settings.globalLayer.loading')}
      </Typography>
    );
  }
  if (query.data.pairs.length === 0) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t('settings.globalLayer.empty')}
      </Typography>
    );
  }
  return (
    <Stack gap="var(--spacing-lg)">
      {query.data.pairs.map((pair) => (
        <GlobalLayerCard key={pair.id} pair={pair} />
      ))}
    </Stack>
  );
}
