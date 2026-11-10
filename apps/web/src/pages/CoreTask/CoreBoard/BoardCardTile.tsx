import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { shortGroupId } from '@entities/CoreTask';
import { cn } from '@shared/lib/cn';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import styles from './CoreBoard.module.scss';
import { RelatedHint } from './Related/RelatedHint';

interface BoardCardTileProps {
  card: BoardCard;
  onOpen: (card: BoardCard) => void;
}

/**
 * Карточка на доске: название и значки фактов от ядра — «ждёт вас», неблокирующие вопросы, единицы,
 * источник, группа, перехват. Нажатие открывает окно карточки — у любой карточки, без исключений.
 */
export function BoardCardTile({ card, onOpen }: BoardCardTileProps) {
  const { t } = useTranslation();
  const C = 'coreBoard.card';
  const title = card.title || t(`${C}.untitled`);
  return (
    <button
      type="button"
      className={cn(styles.card, card.waiting && styles.cardWaiting)}
      onClick={() => onOpen(card)}
      aria-label={t(`${C}.open`, { title })}
      data-board-card={card.id}
      data-board-card-kind={card.kind}
      data-board-card-column={card.column}
      data-board-card-waiting={card.waiting || undefined}
    >
      <Typography variant="body-sm" weight="medium" as="span" className={styles.cardTitle}>
        {title}
      </Typography>
      <span className={styles.chips}>
        {card.waiting && <Badge tone="warning">{t(`${C}.waiting`)}</Badge>}
        {card.questions > 0 && (
          <span title={t(`${C}.questionsHint`)} data-board-card-questions={card.questions}>
            <Badge tone="info">{t(`${C}.questions`, { count: card.questions })}</Badge>
          </span>
        )}
        {card.units && (
          <Badge tone="neutral">
            {t(`${C}.units`, { done: card.units.done, total: card.units.total })}
          </Badge>
        )}
        {card.source && <Badge tone="neutral">{t(`coreBoard.source.${card.source.kind}`)}</Badge>}
        {card.launchOrigin && <Badge tone="accent">{t(`${C}.fromChat`)}</Badge>}
        {card.groupId && (
          <Badge tone="neutral">{`${t(`${C}.group`)} ${shortGroupId(card.groupId)}`}</Badge>
        )}
        {card.takeover && <Badge tone="warning">{t(`${C}.takeover`)}</Badge>}
        <RelatedHint card={card} />
      </span>
      {card.reason && (
        <Typography variant="caption" color="subtle" as="span" truncate title={card.reason}>
          {card.reason}
        </Typography>
      )}
    </button>
  );
}
