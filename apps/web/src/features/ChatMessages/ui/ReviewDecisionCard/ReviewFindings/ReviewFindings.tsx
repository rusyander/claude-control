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
  // Ревью неполное и после просьбы дочитать (U4): пустой список тут — не «чисто».
  const incomplete = review.incomplete?.length ? (
    <Typography variant="body-sm" as="div" className={styles.warning}>
      {t('chat.review.incomplete')}
      <ul className={styles.gaps}>
        {review.incomplete.map((gap) => (
          <li key={gap}>{t(`chat.review.depthGap.${gap}`)}</li>
        ))}
      </ul>
    </Typography>
  ) : null;
  const witness = review.witness ? (
    <Typography variant="caption" color="subtle" as="div" className={styles.clean}>
      {t('chat.review.witness')}
    </Typography>
  ) : null;

  if (review.findings.length === 0) {
    if (incomplete) {
      return (
        <>
          {witness}
          {incomplete}
        </>
      );
    }
    return (
      <>
        {witness}
        <Typography variant="body-sm" color="subtle" className={styles.clean}>
          {t('chat.review.clean')}
        </Typography>
      </>
    );
  }
  return (
    <>
      {witness}
      {incomplete}
      <ol className={styles.list}>
        {review.findings.map((finding, index) => (
          <li key={index}>
            <Typography variant="body-sm" as="div" className={styles.item}>
              {finding}
            </Typography>
          </li>
        ))}
      </ol>
    </>
  );
}
