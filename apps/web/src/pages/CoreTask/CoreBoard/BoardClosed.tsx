import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LegacyRuns } from '../LegacyRuns/LegacyRuns';
import { BoardCardTile } from './BoardCardTile';
import styles from './CoreBoard.module.scss';

interface BoardClosedProps {
  cards: readonly BoardCard[];
  onOpen: (card: BoardCard) => void;
}

/**
 * «Закрытые» — свёрнутым блоком под доской: закрытые задачи ядра и прежние запуски групп (только
 * чтение, D13). Свёрнут по умолчанию: закрытое копится, а доска — о том, что идёт сейчас.
 */
export function BoardClosed({ cards, onOpen }: BoardClosedProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="var(--spacing-sm)" data-board-closed={open ? 'open' : 'folded'}>
      <div>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} />}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-board-closed-toggle
        >
          {open ? t('coreBoard.closed.hide') : t('coreBoard.closed.show', { count: cards.length })}
        </Button>
      </div>
      {open && (
        <>
          {cards.length === 0 ? (
            <Typography variant="body-sm" color="subtle" as="p">
              {t('coreBoard.closed.empty')}
            </Typography>
          ) : (
            <div className={styles.closedGrid} data-board-column="closed">
              {cards.map((card) => (
                <BoardCardTile key={card.id} card={card} onOpen={onOpen} />
              ))}
            </div>
          )}
          <LegacyRuns />
        </>
      )}
    </Stack>
  );
}
