import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLogSources } from '@entities/Logs';
import { EmptyState } from '@shared/ui/empty-state';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import type { LogLevel } from '../../lib/logParse';
import { logsErrorCode, logsErrorText } from '../../lib/logsError';
import { LogSourceList } from './LogSourceList';
import { LogSourceView } from './LogSourceView';
import type { LogsPanelProps } from './Logs.types';
import styles from './Logs.module.scss';

/**
 * Вкладка «Логи»: слева источники — цели «Dev-сервера» и сервисы Compose,
 * справа поток выбранного. Панель логов не хранит: вывод целей держит сервер,
 * пока они живы (и последний запуск после остановки), у сервисов — docker.
 */
export function LogsPanel({ projectPath, isOpen, onAskAgent }: LogsPanelProps) {
  const { t } = useTranslation();
  const sources = useLogSources(projectPath, isOpen);
  const [chosen, setChosen] = useState<string>();
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<LogLevel>();
  const { refetch } = sources;
  const onSourceGone = useCallback(() => void refetch(), [refetch]);

  if (sources.isPending) return <SkeletonList rows={4} withActions />;
  if (sources.isError) {
    if (logsErrorCode(sources.error) === 'logs-project-unregistered') {
      return (
        <EmptyState
          icon="logs"
          title={t('environment.logs.sources.emptyTitle')}
          text={t('environment.logs.errors.unregistered')}
        />
      );
    }
    return (
      <LoadErrorCard
        text={logsErrorText(sources.error, t)}
        onRetry={() => void sources.refetch()}
      />
    );
  }

  const info = sources.data;
  const source = info.sources.find((item) => item.id === chosen) ?? info.sources[0];
  if (!source) {
    return (
      <EmptyState
        icon="logs"
        title={t('environment.logs.sources.emptyTitle')}
        text={[
          t('environment.logs.sources.emptyText'),
          info.docker === 'missing' ? t('environment.logs.sources.dockerMissing') : '',
          info.docker === 'stopped' ? t('environment.logs.sources.dockerStopped') : '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    );
  }

  return (
    <div className={styles.workspace}>
      <LogSourceList info={info} selectedId={source.id} onSelect={setChosen} />
      <LogSourceView
        key={source.id}
        projectPath={projectPath}
        isOpen={isOpen}
        source={source}
        search={search}
        onSearchChange={setSearch}
        {...(level ? { level } : {})}
        onLevelChange={setLevel}
        onSourceGone={onSourceGone}
        {...(onAskAgent ? { onAskAgent } : {})}
      />
    </div>
  );
}
