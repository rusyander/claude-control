import type { ReviewDecisionCardProps } from '../../ReviewDecisionCard.types';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './ReviewFindings.module.scss';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';

/**
 * Что ревью нашло. Нет блока итога — это НЕ «замечаний нет» (Д4): замечания
 * неизвестны, и честная строка вместе с повтором стоит на месте списка.
 */
export function ReviewFindings({
  item,
  onRetry,
  busy,
}: Pick<ReviewDecisionCardProps, 'item' | 'onRetry' | 'busy'>) {
  const { t } = useTranslation();
  const { review, chatId } = item;

  if (review.missing) {
    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" as="div" className={styles.warning}>
          {t('chat.review.missing')}
        </Typography>
        {onRetry && (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
            <Button
              variant="primary"
              leftIcon={<Icon name="refresh" size={18} />}
              isLoading={busy}
              onClick={() => onRetry(chatId)}
            >
              {t('chat.review.retry')}
            </Button>
          </Stack>
        )}
      </Stack>
    );
  }
  if (review.findings.length === 0) {
    return (
      <Typography variant="body-sm" color="subtle" className={styles.clean}>
        {t('chat.review.clean')}
      </Typography>
    );
  }
  return (
    <ol className={styles.list}>
      {review.findings.map((finding, index) => (
        <li key={index}>
          <Typography variant="body-sm" as="div" className={styles.item}>
            {finding}
          </Typography>
        </li>
      ))}
    </ol>
  );
}
