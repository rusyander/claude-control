import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { HandoffCardProps } from './HandoffCard.types';
import styles from './HandoffCard.module.scss';

/**
 * Предложение продолжить работу в чистой сессии.
 *
 * Приходит блоком в ответе агента, а показывается карточкой: решение здесь
 * принимает человек, и принимать его он должен по СОСТАВУ — что закрыто, что
 * вычищено из рабочих файлов и чем продолжать, — а не по формату JSON.
 *
 * Кнопки две, и обе законны: «остаться здесь» — такой же ответ, как и чистая
 * сессия. Тумблер «дальше продолжай сам» стоит рядом намеренно: включают его
 * ровно в тот момент, когда впервые видят, ЧТО именно панель собирается сделать,
 * — а не заранее в настройках, вслепую.
 */
export function HandoffCard({
  proposal,
  onContinue,
  onKeepHere,
  auto,
  onAutoChange,
  chainDepth,
  maxChain,
  isPending,
  disabled,
}: HandoffCardProps) {
  const { t } = useTranslation();
  // «Только завести чат» — когда задание хочется сначала прочитать и поправить,
  // а не получить агента, стартовавшего в ту же секунду.
  const [createOnly, setCreateOnly] = useState(false);

  const isLocked = Boolean(isPending || disabled);
  const showChain = typeof chainDepth === 'number' && chainDepth > 0;

  return (
    <div className={styles.card}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="refresh" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.handoff.title')}
        </Typography>
        {showChain && (
          <span className={styles.chain}>
            {t('chat.handoff.chain', { depth: chainDepth, max: maxChain })}
          </span>
        )}
      </Stack>

      <Typography variant="body-sm" className={styles.done}>
        {proposal.done}
      </Typography>

      {proposal.pruned && (
        <Typography variant="body-sm" color="muted" className={styles.pruned}>
          {t('chat.handoff.pruned', { text: proposal.pruned })}
        </Typography>
      )}

      <div className={styles.next}>
        <Typography variant="body-sm" color="muted" as="span" className={styles.checkpoint}>
          {t('chat.handoff.checkpoint', { file: proposal.checkpoint })}
        </Typography>
        <Typography variant="body-sm" className={styles.nextText}>
          {proposal.next}
        </Typography>
      </div>

      {onContinue && (
        <Stack gap="var(--spacing-2xs)" className={styles.options}>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            <Toggle
              size="sm"
              checked={createOnly}
              onCheckedChange={setCreateOnly}
              disabled={isLocked}
              aria-label={t('chat.handoff.createOnly')}
            />
            <Typography variant="body-sm" color="muted" as="span">
              {t('chat.handoff.createOnly')}
            </Typography>
          </Stack>

          {onAutoChange && (
            <Stack direction="row" align="center" gap="var(--spacing-2xs)">
              <Toggle
                size="sm"
                checked={auto === true}
                onCheckedChange={onAutoChange}
                disabled={isPending}
                aria-label={t('chat.handoff.auto')}
              />
              <Typography variant="body-sm" color="muted" as="span">
                {t('chat.handoff.auto')}
              </Typography>
            </Stack>
          )}
        </Stack>
      )}

      {onContinue && (
        <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
          <Button
            variant="primary"
            leftIcon={<Icon name="refresh" size={18} />}
            onClick={() => onContinue({ startRun: !createOnly })}
            isLoading={isPending}
            disabled={isLocked}
          >
            {t('chat.handoff.apply')}
          </Button>
          {onKeepHere && (
            <Button variant="secondary" onClick={onKeepHere} disabled={isLocked}>
              {t('chat.handoff.keepHere')}
            </Button>
          )}
        </Stack>
      )}
    </div>
  );
}
