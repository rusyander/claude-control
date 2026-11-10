import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { BoardStop } from '@agentdeck/contracts/core/board';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { STOP_CHOICES } from '../../model/queueEntry';
import type { QueueEntryState } from '../../model/useQueueEntry';

interface QueueRowProps {
  queue: QueueEntryState;
}

/**
 * Остановка и исход «В очередь» под формой запуска (B9). Сама кнопка стоит рядом с «Оценить»:
 * обе отправляют одни и те же поля, разница только в том, кто и когда стартует задачу.
 */
export function QueueRow({ queue }: QueueRowProps) {
  const { t } = useTranslation();
  const P = 'coreBoard.queue';
  return (
    <>
      <div data-queue-stop={queue.stop}>
        <SelectField
          label={t(`${P}.stop`)}
          hint={t(`${P}.stopHint`)}
          value={queue.stop}
          options={STOP_CHOICES.map((stop) => ({
            value: stop,
            label: t(`coreBoard.stops.${stop}`),
          }))}
          onChange={(value) => queue.setStop(value as BoardStop)}
        />
      </div>
      {queue.queued !== null && (
        <Typography variant="body-sm" color="success" as="p" data-queue-done={queue.queued}>
          {t(`${P}.done`)}{' '}
          <Link to={CORE_TASKS_ROUTE} search={{ view: 'board' } as never} data-queue-open-board>
            {t(`${P}.openBoard`)}
          </Link>
        </Typography>
      )}
      {queue.refusal !== null && (
        <Typography variant="body-sm" color="danger" as="p" data-queue-refused>
          {t(`${P}.refused`, { reason: queue.refusal })}
        </Typography>
      )}
    </>
  );
}
