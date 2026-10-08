import type { ReviewDecisionCardProps } from '../../ReviewDecisionCard.types';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import styles from './ReviewOutcome.module.scss';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';

/**
 * Чем кончилось решение: что выбрано, ушёл ли комментарий и не пора ли
 * отправлять правки.
 *
 * Отдельной функцией, потому что состояний тут четыре и в разметке карточки они
 * превратились бы в лестницу условий, которую линтер и так не пропустит.
 */
export function ReviewOutcome({
  item,
  onPush,
  busy,
}: Pick<ReviewDecisionCardProps, 'item' | 'onPush' | 'busy'>) {
  const { t } = useTranslation();
  const { review, chatId } = item;
  if (!review.decidedAt) return null;

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.outcome}>
      <Typography variant="caption" color="subtle" as="span">
        {t(`chat.review.decided.${review.decision ?? 'none'}`)}
      </Typography>

      {review.postedAt && (
        <Typography variant="caption" color="subtle" as="span">
          {t('chat.review.posted')}
        </Typography>
      )}
      {/* Отказ форджа — не молча: комментарий не ушёл, и написать его человеку
          придётся самому либо починив интеграцию. */}
      {review.postError && (
        <Typography variant="caption" as="span" className={styles.error}>
          {t('chat.review.postFailed', { message: review.postError })}
        </Typography>
      )}

      {review.pushedAt && (
        <Typography variant="caption" color="subtle" as="span">
          {t('chat.review.pushed')}
        </Typography>
      )}
      {/* Правки есть, а отправить их некуда (Д9): молчащая кнопка хуже причины. */}
      {review.pushBlocked && !review.pushedAt && (
        <Typography variant="caption" as="span" className={styles.error}>
          {t('chat.review.pushBlocked')}
        </Typography>
      )}
      {/* Правки готовы — но push в чужую ветку панель сама не делает никогда:
          это второе, отдельное согласие. */}
      {review.pushOffer && onPush && (
        <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
          <Button
            variant="primary"
            leftIcon={<Icon name="branch" size={18} />}
            isLoading={busy}
            onClick={() => onPush(chatId)}
          >
            {t('chat.review.push')}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
