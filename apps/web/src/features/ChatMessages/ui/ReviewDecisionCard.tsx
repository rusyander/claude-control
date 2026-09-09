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
        <span className={styles.count}>
          {t('chat.cascade.review.count', { count: findings.length })}
        </span>
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

      {findings.length === 0 ? (
        <Typography variant="body-sm" color="subtle" className={styles.clean}>
          {t('chat.review.clean')}
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
