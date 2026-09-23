import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import type { ReviewDecisionCardProps } from './ReviewDecisionCard.types';
import styles from './ReviewDecisionCard.module.scss';

/**
 * Что делать с замечаниями по чужому запросу на слияние (Т7).
 *
 * Конвейер подбора после ревью заводит правки сам, и там это правильно: работа
 * своя, ветка своя. Здесь оба напрашивающихся действия — написать в чужой MR и
 * переписать чужую ветку — человек разрешает поимённо, поэтому карточка и есть
 * весь механизм: панель довела ревью до списка замечаний и остановилась.
 *
 * Показывается в двух местах — в хабе родителя и в самом чате группы, — но
 * состояние у неё одно: связь чата. Два источника разошлись бы на первом же
 * перезапуске, и человек увидел бы в хабе непринятое решение, которое он уже
 * принял в чате.
 *
 * Решённая карточка не исчезает: по ней вспоминают, что выбрали и чем это
 * кончилось. Отказ форджа живёт здесь же — «правки пошли, комментарий не ушёл»
 * это один исход, а не два.
 */
export function ReviewDecisionCard({
  item,
  others = 0,
  onDecide,
  onPush,
  onRetry,
  busy,
}: ReviewDecisionCardProps) {
  const { t } = useTranslation();
  // «Ко всем» по умолчанию выключено: решение о чужом MR принимается по одному,
  // а оптовое — осознанным переключением.
  const [all, setAll] = useState(false);
  const { review, chatId } = item;
  const findings = review.findings;
  const decided = Boolean(review.decidedAt);
  const canPost = !review.postBlocked;

  const decide = (decision: TaskSplitReviewDecision): void => onDecide(chatId, decision, all);

  return (
    <div
      className={cn(styles.card, decided && styles.decided)}
      data-review-card={decided ? 'decided' : 'waiting'}
    >
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="link" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {item.title ? t('chat.review.titleNamed', { title: item.title }) : t('chat.review.title')}
        </Typography>
        {/* Без итога счётчик соврал бы «0 замечаний»: их число неизвестно (Д4). */}
        {!review.missing && (
          <span className={styles.count}>
            {t('chat.cascade.review.count', { count: findings.length })}
          </span>
        )}
      </Stack>

      {/* Ссылка целиком, а не «MR №42»: человек по ней и уходит смотреть. */}
      <a className={styles.link} href={review.url} target="_blank" rel="noreferrer noopener">
        {review.url}
      </a>
      {review.branch && (
        <span className={styles.branch}>{t('chat.review.branch', { branch: review.branch })}</span>
      )}

      {review.onMrBranch === false && (
        <Typography variant="caption" as="div" className={styles.warning}>
          {t('chat.review.offBranch')}
        </Typography>
      )}

      <ReviewFindings item={item} onRetry={onRetry} busy={busy} />

      {/* Выбор есть только пока он не сделан: перерешать нечего — правки уже
          заведены, а комментарий уже написан в чужое обсуждение. */}
      {!decided && findings.length > 0 && (
        <>
          {others > 0 && (
            <Stack
              direction="row"
              align="center"
              gap="var(--spacing-2xs)"
              className={styles.applyAll}
            >
              <Toggle
                size="sm"
                checked={all}
                onCheckedChange={setAll}
                disabled={busy}
                aria-label={t('chat.review.applyAll', { count: others })}
              />
              <Typography variant="body-sm" color="muted" as="span">
                {t('chat.review.applyAll', { count: others })}
              </Typography>
            </Stack>
          )}

          <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
            <Button variant="primary" isLoading={busy} onClick={() => decide('fix')}>
              {t('chat.review.fix')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canPost}
              title={review.postBlocked}
              onClick={() => decide('post')}
            >
              {t('chat.review.post')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canPost}
              title={review.postBlocked}
              onClick={() => decide('both')}
            >
              {t('chat.review.both')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => decide('none')}>
              {t('chat.review.none')}
            </Button>
          </Stack>
        </>
      )}

      <ReviewOutcome item={item} onPush={onPush} busy={busy} />
    </div>
  );
}

/**
 * Что ревью нашло. Нет блока итога — это НЕ «замечаний нет» (Д4): замечания
 * неизвестны, и честная строка вместе с повтором стоит на месте списка.
 */
function ReviewFindings({
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

/**
 * Чем кончилось решение: что выбрано, ушёл ли комментарий и не пора ли
 * отправлять правки.
 *
 * Отдельной функцией, потому что состояний тут четыре и в разметке карточки они
 * превратились бы в лестницу условий, которую линтер и так не пропустит.
 */
function ReviewOutcome({
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
