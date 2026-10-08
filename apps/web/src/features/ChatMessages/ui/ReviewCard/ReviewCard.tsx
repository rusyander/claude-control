import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { ReviewCardProps } from './ReviewCard.types';
import styles from './ReviewCard.module.scss';

/**
 * Вердикт ревью: что нашла модель-потолок в работе, сделанной моделью слабее.
 *
 * Приходит блоком в ответе агента и показывается карточкой по той же причине,
 * что разделение и продолжение: сырой JSON в ленте не читается. Но, в отличие от
 * них, решать здесь человеку нечего — звено правок панель заводит сама, а
 * карточка отвечает на единственный оставшийся вопрос: что именно нашли.
 *
 * Пустой список — не пустая карточка: «проверено, замечаний нет» это результат,
 * ради которого понижение и оплачивалось, и молчать о нём значило бы показывать
 * проверку только тогда, когда она нашла плохое.
 */
export function ReviewCard({ findings }: ReviewCardProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.card}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="check" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.cascade.review.title')}
        </Typography>
        <span className={styles.count}>
          {t('chat.cascade.review.count', { count: findings.length })}
        </span>
      </Stack>

      {findings.length === 0 ? (
        <Typography variant="body-sm" color="subtle">
          {t('chat.cascade.review.clean')}
        </Typography>
      ) : (
        <ol className={styles.list}>
          {findings.map((finding, index) => (
            <li key={index}>
              <Typography variant="body-sm" as="div" className={styles.item}>
                {finding}
              </Typography>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
