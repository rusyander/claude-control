import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import {
  cardsByColumn,
  coreRefusalOf,
  filterCards,
  groupIdsOf,
  lanesOf,
  sentPhaseOf,
  shortGroupId,
  useBoardMove,
  useCoreBoard,
  waitingCount,
  windowCardOf,
} from '@entities/CoreTask';
import { CoreFaultCard } from '@features/CoreFault';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CoreTaskCardModal } from '../CoreTaskCardModal/CoreTaskCardModal';
import type { CoreBoardSearch } from '../model/boardSearch';
import { BoardClosed } from './BoardClosed';
import { BoardColumns } from './BoardColumns';
import { BoardToolbar } from './BoardToolbar';
import styles from './CoreBoard.module.scss';
import { BoardInbox } from './Inbox/BoardInbox';

interface CoreBoardProps {
  search: CoreBoardSearch;
}

/**
 * Доска задач ядра (этап 12, B7, D13): вид раздела `/core` по умолчанию. Карточки, колонки,
 * «ждёт вас» и разрешённые ходы — из ОДНОГО ответа ядра `GET /v1/board`, перечитываемого раз в
 * 5 с; панель только раскладывает его. `?lane=group` — полосы групп (бывшая страница «Группы»),
 * `?group=<id>` — одна группа.
 */
export function CoreBoard({ search }: CoreBoardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const board = useCoreBoard();
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Ход из окна живёт здесь, а не в окне: перечитка доски после отказа может убрать карточку
  // (вторая страница её отклонила) или подменить её задачей — отказ остаётся виден на снимке.
  const move = useBoardMove();
  const [sentFrom, setSentFrom] = useState<BoardCard | null>(null);
  const refusal = coreRefusalOf(board.error);

  const setSearch = (patch: Partial<CoreBoardSearch>) =>
    void navigate({
      to: '/core',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, view: 'board', ...patch } as Record<string, unknown>;
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next;
      },
      replace: true,
    } as never);

  if (board.isLoading) return <SkeletonList rows={4} />;
  if (refusal) return <CoreFaultCard refusal={refusal} />;
  if (board.error || !board.data) {
    const reason = board.error instanceof Error ? board.error.message : String(board.error);
    return (
      <EmptyState
        icon="warning"
        title={t('coreBoard.unavailable.title')}
        text={t('coreBoard.unavailable.text', { reason })}
      />
    );
  }

  const all = board.data.cards;
  const open = all.filter((c) => c.column !== 'closed');
  const closed = all.filter((c) => c.column === 'closed');
  const shown = filterCards(open, { group: search.group, waitingOnly });
  const sent = sentFrom ? { card: sentFrom, phase: sentPhaseOf(move) } : null;
  const opened = windowCardOf(all, openId, sent);
  const openCard = (card: BoardCard) => {
    move.reset();
    setSentFrom(null);
    setOpenId(card.id);
  };
  const closeCard = () => {
    move.reset();
    setSentFrom(null);
    setOpenId(null);
  };
  const lanes = search.lane === 'group';

  return (
    <Stack gap="var(--spacing-md)" data-core-board data-board-lane={lanes ? 'group' : 'none'}>
      <BoardToolbar
        limits={board.data.limits}
        configIssues={board.data.configIssues}
        waiting={waitingCount(board.data)}
        waitingOnly={waitingOnly}
        onWaitingOnly={setWaitingOnly}
        lanes={lanes}
        onLanes={(on) => setSearch({ lane: on ? 'group' : undefined })}
        groups={groupIdsOf(open, search.group)}
        group={search.group}
        onGroup={(group) => setSearch({ group })}
      />
      <BoardInbox />
      {all.length === 0 && (
        <EmptyState
          icon="layers"
          title={t('coreBoard.empty.title')}
          text={t('coreBoard.empty.text')}
        />
      )}
      {all.length > 0 && !lanes && <BoardColumns cards={shown} onOpen={openCard} />}
      {all.length > 0 && lanes && <BoardLanes cards={shown} onOpen={openCard} />}
      <BoardClosed cards={closed} onOpen={openCard} />
      {opened.card && (
        <CoreTaskCardModal
          card={opened.card}
          column={cardsByColumn(all)[opened.card.column]}
          onClose={closeCard}
          move={move}
          onSend={setSentFrom}
          stale={opened.stale}
        />
      )}
    </Stack>
  );
}

/** Полосы групп: по полосе на `groupId`, внутри — те же колонки стадий. */
function BoardLanes({ cards, onOpen }: { cards: BoardCard[]; onOpen: (card: BoardCard) => void }) {
  const { t } = useTranslation();
  const lanes = lanesOf(cards);
  if (lanes.length === 0) {
    return (
      <Typography variant="body-sm" color="subtle" as="p" data-board-lanes-empty>
        {t('coreBoard.lane.empty')}
      </Typography>
    );
  }
  return (
    <Stack gap="var(--spacing-md)">
      {lanes.map((lane) => (
        <section
          key={lane.groupId}
          className={styles.lane}
          data-board-lane-group={lane.groupId}
          data-board-lane-count={lane.cards.length}
          // Агент панели открывает `/groups` с фокусом-группой — якорь находит её полосу.
          data-agent-anchor={lane.groupId}
        >
          <Stack direction="row" gap="var(--spacing-xs)" align="center">
            <Typography variant="body" weight="medium" as="h2">
              {t('coreBoard.lane.title', { id: shortGroupId(lane.groupId) })}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t('coreBoard.lane.count', { count: lane.cards.length })}
            </Typography>
          </Stack>
          <BoardColumns cards={lane.cards} onOpen={onOpen} lane={lane.groupId} />
        </section>
      ))}
    </Stack>
  );
}
