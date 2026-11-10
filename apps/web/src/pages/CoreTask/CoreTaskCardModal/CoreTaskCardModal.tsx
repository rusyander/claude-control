import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useCoreTask } from '@entities/CoreTask';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Badge } from '@shared/ui/badge';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { EntryPreset } from '../CoreBoard/Inbox/EntryPreset';
import { RelatedMerge } from '../CoreBoard/Related/RelatedMerge';
import { CardFactsList } from './CardFactsList';
import { CardMoves } from './CardMoves';
import { CardWaiting } from './CardWaiting';
import type { CoreTaskCardModalProps } from './CoreTaskCardModal.types';
import styles from './CoreTaskCardModal.module.scss';

/**
 * Окно карточки доски (D14): открывается у КАЖДОЙ карточки — записи до старта и задачи. Факты —
 * из карточки доски и вида задачи; у записи вида нет, и её расход, агенты и ход по единицам —
 * «нет данных». Ждущее человека (вопросы, окно, перехват) — только у задачи: у записи журнала нет.
 */
export function CoreTaskCardModal({
  card,
  column,
  onClose,
  move,
  onSend,
  stale,
}: CoreTaskCardModalProps) {
  const { t } = useTranslation();
  const taskId = card.kind === 'task' ? (card.taskId ?? card.id) : undefined;
  const task = useCoreTask(taskId);
  const view = task.data?.view;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={card.title || t('coreBoard.card.untitled')}
      size="lg"
      headerActions={
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone={card.waiting ? 'warning' : 'neutral'}>
            {t(`coreBoard.columns.${card.column}`)}
          </Badge>
          {card.waiting && <Badge tone="warning">{t('coreBoard.card.waiting')}</Badge>}
          {taskId && (
            <Link to={CORE_TASKS_ROUTE} search={{ id: taskId } as never} data-card-open-full>
              <Typography variant="body-sm" as="span" color="accent">
                {t('coreBoard.modal.openFull')}
              </Typography>
            </Link>
          )}
        </Stack>
      }
    >
      <Stack gap="var(--spacing-md)" data-card-modal={card.id} data-card-kind={card.kind}>
        {stale && (
          <Typography variant="body-sm" color="warning" as="p" role="status" data-card-stale>
            {t('coreBoard.modal.stale')}
          </Typography>
        )}
        {taskId && task.isLoading && (
          <Typography variant="caption" color="subtle" as="p">
            {t('coreBoard.modal.viewLoading')}
          </Typography>
        )}
        <CardFactsList card={card} view={view} />
        {taskId && (
          <div className={styles.section}>
            <CardWaiting taskId={taskId} card={card} view={view} />
          </div>
        )}
        <div className={styles.section}>
          <Stack gap="var(--spacing-md)">
            <EntryPreset card={card} />
            <CardMoves card={card} column={column} move={move} onSend={onSend} stale={stale} />
            <RelatedMerge card={card} />
          </Stack>
        </div>
      </Stack>
    </Modal>
  );
}
