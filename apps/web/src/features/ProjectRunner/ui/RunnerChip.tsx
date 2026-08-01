import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useStopRunner } from '@entities/ProjectRunner';
import type { RunnerChipProps } from './RunnerChip.types';
import styles from './ProjectRunnerControls.module.scss';

/**
 * Запущенная цель в ряду: ссылка на адрес и кнопка остановки. Адреса ещё нет —
 * вместо ссылки честная надпись, а не битый переход.
 */
export function RunnerChip({ path, run, withName }: RunnerChipProps) {
  const { t } = useTranslation();
  const stop = useStopRunner();

  const label = withName ? run.name : t('runner.open');
  const isStarting = run.status === 'starting';

  return (
    <span className={styles.chip}>
      {run.url ? (
        <a className={styles.link} href={run.url} target="_blank" rel="noreferrer" title={run.url}>
          <Icon name="link" size={16} />
          {label}
          {run.port !== undefined && <span className={styles.port}>:{run.port}</span>}
        </a>
      ) : (
        <span
          className={styles.pending}
          title={isStarting ? run.command : t('runner.noAddressHint')}
        >
          <Icon name={isStarting ? 'history' : 'info'} size={16} />
          {isStarting ? t('runner.starting') : `${label} · ${t('runner.noAddress')}`}
        </span>
      )}

      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Icon name="stop" size={16} />}
        aria-label={`${t('runner.stop')}: ${run.name}`}
        title={t('runner.stop')}
        isLoading={stop.isPending}
        onClick={() =>
          stop.mutate(
            { path, dir: run.dir },
            { onError: (error) => toast.error(toErrorMessage(error)) },
          )
        }
      />
    </span>
  );
}
