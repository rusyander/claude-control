import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposeAction, useComposeInfo, type ComposeAction } from '@entities/Compose';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { composeActionError } from '../../lib/actionError';
import { ComposeDangerZone } from '../ComposeDangerZone/ComposeDangerZone';
import { ComposeJobPanel } from '../ComposeJobPanel/ComposeJobPanel';
import { ComposeServiceRow } from './ComposeServiceRow';
import type { ComposeServicesProps } from './ComposeServices.types';
import styles from './ComposeServices.module.scss';

/**
 * Вкладка «Сервисы»: стек Docker Compose проекта. Каждое состояние, в котором
 * поднять стек нельзя (нет docker, он не запущен, нет файла, файл не принят),
 * объясняет себя само и говорит, что сделать, — пустая таблица ничего не
 * объясняет.
 */
export function ComposeServices({ projectPath, isOpen }: ComposeServicesProps) {
  const { t } = useTranslation();
  const info = useComposeInfo(projectPath, isOpen);
  const action = useComposeAction();
  const [error, setError] = useState<string>();
  // Кнопки гаснут, пока идёт действие, и фокус с нажатой ушёл бы в никуда —
  // переносим его на блок до того, как она погаснет.
  const blockRef = useRef<HTMLDivElement>(null);

  const run = (kind: ComposeAction, service?: string): void => {
    setError(undefined);
    blockRef.current?.focus();
    action.mutate(
      {
        path: projectPath,
        action: kind,
        ...(service ? { service } : {}),
        ...(kind === 'down-volumes' ? { confirm: true } : {}),
      },
      { onError: (failure) => setError(composeActionError(failure, t)) },
    );
  };

  if (info.isPending) return <SkeletonList rows={3} withActions />;
  if (!info.data) return <LoadErrorCard onRetry={() => void info.refetch()} />;

  const data = info.data;
  if (data.docker === 'missing') {
    return (
      <EmptyState
        icon="layers"
        title={t('environment.docker.missingTitle')}
        text={t('environment.docker.missingText')}
      />
    );
  }
  if (!data.file) {
    return (
      <EmptyState
        icon="layers"
        title={t('environment.file.missingTitle')}
        text={t('environment.file.missingText')}
      />
    );
  }

  const isBusy = action.isPending || data.job?.status === 'running';
  const override = data.files.find((file) => file !== data.file);
  const canAct = data.docker === 'ok' && data.configError === undefined;

  return (
    <div ref={blockRef} className={styles.block} tabIndex={-1}>
      <dl className={styles.facts}>
        <div>
          <dt>{t('environment.file.label')}</dt>
          <dd>
            <code className={styles.mono}>{data.file}</code>
            {override && (
              <span className={styles.sub}>
                {' '}
                {t('environment.file.withOverride', { file: override })}
              </span>
            )}
          </dd>
        </div>
        {data.projectName && (
          <div>
            <dt title={t('environment.file.projectHint')}>{t('environment.file.project')}</dt>
            <dd>
              <code className={styles.mono}>{data.projectName}</code>
            </dd>
          </div>
        )}
      </dl>

      {data.docker === 'stopped' && (
        <div className={styles.notice} data-tone="warning" role="status">
          <p className={styles.noticeTitle}>
            <Icon name="warning" size={16} />
            {t('environment.docker.stoppedTitle')}
          </p>
          <p>{t('environment.docker.stoppedText')}</p>
          {data.dockerDetail && (
            <details className={styles.detail}>
              <summary>{t('environment.docker.detail')}</summary>
              <pre>{data.dockerDetail}</pre>
            </details>
          )}
        </div>
      )}

      {data.configError !== undefined && (
        <div className={styles.notice} data-tone="danger" role="alert">
          <p className={styles.noticeTitle}>
            <Icon name="error" size={16} />
            {t('environment.file.configErrorTitle', { file: data.file })}
          </p>
          <p>{t('environment.file.configErrorText')}</p>
          <pre className={styles.errorText}>{data.configError}</pre>
        </div>
      )}

      {canAct && (
        <>
          <div className={styles.stackBar} role="group" aria-label={t('environment.stack.label')}>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="play" size={16} />}
              disabled={isBusy || data.services.length === 0}
              onClick={() => run('up')}
            >
              {t('environment.stack.up')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="stop" size={16} />}
              disabled={isBusy || data.services.length === 0}
              onClick={() => run('stop')}
            >
              {t('environment.stack.stop')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="refresh" size={16} />}
              disabled={isBusy || data.services.length === 0}
              onClick={() => run('restart')}
            >
              {t('environment.stack.restart')}
            </Button>
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {data.services.length === 0 ? (
            <p className={styles.sub}>{t('environment.stack.empty')}</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>{t('environment.table.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('environment.table.service')}</th>
                    <th scope="col">{t('environment.table.image')}</th>
                    <th scope="col">{t('environment.table.state')}</th>
                    <th scope="col">{t('environment.table.ports')}</th>
                    <th scope="col">{t('environment.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.services.map((service) => (
                    <ComposeServiceRow
                      key={service.name}
                      service={service}
                      isBusy={isBusy}
                      onAction={run}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {data.job && <ComposeJobPanel job={data.job} />}

      {canAct && (
        <ComposeDangerZone
          volumes={data.volumes}
          isBusy={isBusy}
          onDown={() => run('down')}
          onDownVolumes={() => run('down-volumes')}
        />
      )}
    </div>
  );
}
