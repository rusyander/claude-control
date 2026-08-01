import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useFreePort, usePortHolders, useStartRunner } from '@entities/ProjectRunner';
import type { BusyPortNoticeProps } from './BusyPortNotice.types';
import styles from './ProjectRunnerControls.module.scss';

/**
 * «Порт занят» — с именем процесса, который его держит, и одной кнопкой.
 *
 * Панель НИКОГО не убивает сама: даже когда порт держит явно чужой процесс,
 * решение остаётся за человеком — за портом может стоять база, соседний проект
 * или docker. Поэтому сначала показываем, кто там, и только клик освобождает
 * порт и повторяет запуск.
 */
export function BusyPortNotice({ path, dir, port }: BusyPortNoticeProps) {
  const { t } = useTranslation();
  const holders = usePortHolders(port);
  const free = useFreePort();
  const start = useStartRunner();

  const who = (holders.data?.holders ?? [])
    .map(
      (holder) =>
        `${holder.name ?? 'PID'} · ${holder.pid}${holder.ours ? ` · ${t('runner.portOurs')}` : ''}`,
    )
    .join(', ');

  const onFree = (): void => {
    free.mutate(
      { port },
      {
        onSuccess: (info) => {
          // Порт мог не отпуститься: процесс без прав на убийство или сокет в
          // TIME_WAIT. Тогда честнее сказать это, чем запускать заведомо в стену.
          if (info.busy) {
            toast.error(t('runner.portStillBusy', { port }));
            return;
          }
          start.mutate({ path, dir }, { onError: (error) => toast.error(toErrorMessage(error)) });
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <span className={styles.busy} title={who || undefined}>
      <Icon name="warning" size={16} />
      <span className={styles.busyText}>
        {t('runner.portBusy', { port })}
        {who && <span className={styles.busyWho}>{who}</span>}
      </span>
      <Button
        variant="secondary"
        size="sm"
        isLoading={free.isPending || start.isPending}
        onClick={onFree}
      >
        {t('runner.freePort')}
      </Button>
    </span>
  );
}
