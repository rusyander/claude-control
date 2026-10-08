import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useProviders } from '@entities/Provider';
import type { SourceNoteProps } from './SourceNote.types';

/**
 * Чей это отчёт и чего в нём нет. У Codex и Qwen аналитика читает их
 * собственные файлы сессий, а не транскрипты Claude, — без подписи цифры
 * выглядели бы расходом Claude. Модели без цены названы поимённо: их ноль в
 * стоимости — отсутствие тарифа, а не бесплатный расход.
 */
export function SourceNote({ providerId, unpricedModels }: SourceNoteProps) {
  const { t } = useTranslation();
  const { data: providers } = useProviders();
  if (!providerId && !unpricedModels?.length) return null;
  const name = providers?.providers.find((p) => p.id === providerId)?.name ?? providerId;
  return (
    <Stack gap="var(--spacing-3xs)" data-testid="analytics-source-note">
      {providerId && (
        <Typography variant="body-sm" color="muted">
          {t('analytics.foreignSource', { cli: name })}
        </Typography>
      )}
      {unpricedModels && unpricedModels.length > 0 && (
        <Typography variant="body-sm" color="muted">
          {t('analytics.unpricedModels', { models: unpricedModels.join(', ') })}
        </Typography>
      )}
    </Stack>
  );
}
