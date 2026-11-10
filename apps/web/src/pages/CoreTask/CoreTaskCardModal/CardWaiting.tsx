import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { askWaits } from '@agentdeck/contracts/core/waiting';
import { CORE_BOARD_KEY } from '@entities/CoreTask';
import { AskCard } from '@features/CoreAsk';
import { CoreTakeoverAction } from '@features/CoreTakeover';
import { useCoreTimeline } from '@features/CoreTimeline';
import { CoreWindowOffer } from '@features/CoreWindowOffer';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { openAsks } from '../model/taskPage';

interface CardWaitingProps {
  taskId: string;
  card: BoardCard;
  view: TaskView | undefined;
}

/**
 * Что ждёт человека в окне карточки (D14): блокирующие вопросы — карточками ответа (те же, что на
 * ленте задачи), ожидание окна — вариантами перевода, перехват единицы — его кнопкой. Вопросы — из
 * живой ленты задачи; блокирует ли вопрос, решает общая функция `askWaits`, как у доски ядра.
 */
export function CardWaiting({ taskId, card, view }: CardWaitingProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { fold } = useCoreTimeline(taskId);
  const viewAsks = useMemo(() => new Map((view?.asks ?? []).map((a) => [a.askId, a])), [view]);
  const blocking = useMemo(
    () =>
      openAsks(fold, view).filter(({ ask, state }) =>
        askWaits({
          defaultAction: viewAsks.get(ask.askId)?.defaultAction ?? ask.defaultAction,
          state: state ?? 'open',
        }),
      ),
    [fold, view, viewAsks],
  );
  const reread = () => void queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY });

  return (
    <Stack gap="var(--spacing-sm)" data-card-waiting={blocking.length}>
      {blocking.length > 0 && (
        <Typography variant="body-sm" weight="medium" as="h3">
          {t('coreBoard.modal.waiting')}
        </Typography>
      )}
      {blocking.map(({ ask, state }) => (
        <AskCard key={ask.askId} taskId={taskId} ask={ask} state={state} />
      ))}
      {view?.windowWait && <CoreWindowOffer taskId={taskId} view={view} onDone={reread} />}
      <CoreTakeoverAction taskId={taskId} card={card} onDone={reread} />
    </Stack>
  );
}
