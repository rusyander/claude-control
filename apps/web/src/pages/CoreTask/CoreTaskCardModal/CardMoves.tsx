import { useTranslation } from 'react-i18next';
import type { BoardCard, BoardMoveTo } from '@agentdeck/contracts/core/board';
import {
  boardMoveRefusalOf,
  moveTargetOf,
  moveUp,
  shownMoves,
  type BoardMove,
  type KeyedRefusal,
} from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { moveRefusalOf } from './cardMoves.lib';

interface CardMovesProps {
  card: BoardCard;
  column: readonly BoardCard[];
  /** Ход живёт на доске, не в окне: отказ переживает перечитку, которая убрала бы окно. */
  move: BoardMove;
  /** Снимок карточки в миг хода — доска держит окно на нём, пока ход в пути или отказан. */
  onSend?: (card: BoardCard) => void;
  /** Окно на снимке: карточка на доске уже другая — ходов нет, только отказ. */
  stale?: boolean;
}

/**
 * Ходы карточки (D8, P152, P160): кнопки — ровно разрешённые ядром ходы, ни одной сверх. Свободного
 * перетаскивания между колонками стадий нет — стадию двигает журнал задачи. Отказ ядра (409) — его
 * причиной и списком того, что разрешено сейчас. Окно на снимке (`stale`) кнопок не рисует: ходы
 * снимка устарели, разрешённое сейчас называет строка отказа.
 */
export function CardMoves({ card, column, move, onSend, stale = false }: CardMovesProps) {
  const { t } = useTranslation();
  const moves = stale ? [] : shownMoves(card);
  const up = stale ? null : moveUp(card, column);
  const target = moveTargetOf(card);
  const refusal = move.isError ? boardMoveRefusalOf(move.error) : null;
  const keyed = move.isError ? moveRefusalOf(move.error) : null;
  // Ход и состояние из прозы ядра — словами интерфейса; незнакомое слово остаётся как есть.
  const reasonText = (r: KeyedRefusal) =>
    t(`coreBoard.moves.refusals.${r.key}`, {
      move: r.values.move
        ? t(`coreBoard.moves.${r.values.move}`, { defaultValue: r.values.move })
        : '',
      state: r.values.state
        ? t(`coreBoard.entryState.${r.values.state}`, { defaultValue: r.values.state })
        : '',
    });
  const send = (to: BoardMoveTo, before?: string) => {
    onSend?.(card);
    move.mutate({ ...target, to, ...(before ? { before } : {}) });
  };

  return (
    <Stack gap="var(--spacing-xs)" data-card-moves={moves.join(',')}>
      <Typography variant="body-sm" weight="medium" as="h3">
        {t('coreBoard.moves.label')}
      </Typography>
      {moves.length === 0 && !up && !stale && (
        <Typography variant="body-sm" color="subtle" as="p" data-card-moves-none>
          {t('coreBoard.moves.none')}
        </Typography>
      )}
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        {moves.map((to) => (
          <Button
            key={to}
            size="sm"
            variant={to === 'rejected' ? 'danger' : 'secondary'}
            isLoading={move.isPending && move.variables?.to === to && !move.variables.before}
            onClick={() => send(to)}
            data-card-move={to}
          >
            {t(`coreBoard.moves.${to}`)}
          </Button>
        ))}
        {up && (
          <Button
            size="sm"
            variant="ghost"
            title={t('coreBoard.moves.upHint')}
            isLoading={move.isPending && Boolean(move.variables?.before)}
            onClick={() => send(up.to, up.before)}
            data-card-move="up"
          >
            {t('coreBoard.moves.up')}
          </Button>
        )}
      </Stack>
      {refusal && (
        <Stack gap="var(--spacing-3xs)" data-card-move-refused={refusal.code ?? refusal.status}>
          {keyed && (
            <Typography
              variant="body-sm"
              color="danger"
              as="p"
              role="alert"
              title={keyed.raw}
              data-card-move-reason={keyed.key}
            >
              {t('coreBoard.moves.refused', { reason: reasonText(keyed) })}
            </Typography>
          )}
          {refusal.allowed && (
            <Typography variant="caption" color="subtle" as="p" data-card-move-allowed>
              {refusal.allowed.length > 0
                ? t('coreBoard.moves.allowed', {
                    list: refusal.allowed.map((m) => t(`coreBoard.moves.${m}`)).join(', '),
                  })
                : t('coreBoard.moves.allowedNone')}
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
}
