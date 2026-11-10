import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { STAGE_COLUMNS, cardsByColumn } from '@entities/CoreTask';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { BoardCardTile } from './BoardCardTile';
import styles from './CoreBoard.module.scss';

interface BoardColumnsProps {
  cards: readonly BoardCard[];
  onOpen: (card: BoardCard) => void;
  /** Метка ряда для QA и экранного диктора: вся доска или полоса группы. */
  lane?: string;
}

/**
 * Колонки стадий слева направо — порядок контракта; в какой колонке карточка, решило ядро.
 * Перетаскивания нет (D8): ход карточки — кнопками её окна, только разрешённые.
 */
export function BoardColumns({ cards, onOpen, lane }: BoardColumnsProps) {
  const { t } = useTranslation();
  const byColumn = cardsByColumn(cards);
  return (
    <div className={styles.columns} data-board-columns={lane ?? 'all'}>
      {STAGE_COLUMNS.map((column) => {
        const list = byColumn[column];
        const name = t(`coreBoard.columns.${column}`);
        return (
          <section
            key={column}
            className={styles.column}
            aria-label={t('coreBoard.columnAria', { name, count: list.length })}
            data-board-column={column}
            data-board-column-count={list.length}
          >
            <div className={styles.columnHead}>
              <Typography variant="body-sm" weight="medium" as="h3">
                {name}
              </Typography>
              <Badge tone={column === 'waiting' && list.length > 0 ? 'warning' : 'neutral'}>
                {list.length}
              </Badge>
            </div>
            {list.length === 0 && (
              <Typography variant="caption" color="muted" as="span">
                {t('coreBoard.columnEmpty')}
              </Typography>
            )}
            {list.map((card) => (
              <BoardCardTile key={card.id} card={card} onOpen={onOpen} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
