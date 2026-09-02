import { useTranslation } from 'react-i18next';
import { Card } from '../card';
import { Stack } from '../stack';
import { Typography } from '../typography';
import { Button } from '../button';

export interface LoadErrorCardProps {
  /** Повторить запрос — без перезагрузки вкладки. */
  onRetry: () => void;
  /** Свой заголовок; по умолчанию общий «не удалось загрузить данные раздела». */
  title?: string;
  /** Своё пояснение; по умолчанию общее «сервер не ответил». */
  text?: string;
}

/**
 * Раздел не смог загрузить данные. Раньше страницы в этом случае крутили
 * скелет без конца, и отличить «грузится» от «сломано» было нельзя — теперь
 * говорим прямо и даём повторить.
 */
export function LoadErrorCard({ onRetry, title, text }: LoadErrorCardProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {title ?? t('common.loadError')}
        </Typography>
        <Typography variant="body-sm" color="subtle">
          {text ?? t('common.loadErrorText')}
        </Typography>
        <div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      </Stack>
    </Card>
  );
}
