import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { LogSource } from '@entities/Logs';
import { Icon } from '@shared/ui/icon';
import { StatusDot, type StatusDotProps } from '@shared/ui/status-dot';
import type { LogSourceListProps } from './Logs.types';
import styles from './Logs.module.scss';

/** Состояние цели («Dev-сервер») или контейнера → тон точки; значения двух миров разные. */
const TONE: Record<string, { tone: NonNullable<StatusDotProps['tone']>; pulse?: boolean }> = {
  running: { tone: 'success' },
  starting: { tone: 'warning', pulse: true },
  restarting: { tone: 'warning', pulse: true },
  error: { tone: 'danger' },
  dead: { tone: 'danger' },
};

const STATES = new Set([
  'starting',
  'running',
  'stopped',
  'error',
  'exited',
  'restarting',
  'created',
  'paused',
  'dead',
]);

function SourceButton({
  source,
  isSelected,
  onSelect,
}: {
  source: LogSource;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const isAll = source.id === 'compose:*';
  const state = STATES.has(source.state)
    ? t(`environment.logs.sources.state.${source.state}`)
    : source.state;
  const look = TONE[source.state] ?? { tone: 'neutral' as const };
  return (
    <button
      type="button"
      className={styles.source}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
      {...(isAll ? { title: t('environment.logs.sources.allHint') } : {})}
    >
      <span className={styles.sourceHead}>
        {isAll ? (
          <Icon name="layers" size={12} className={styles.sourceIcon} />
        ) : (
          <StatusDot tone={look.tone} pulse={Boolean(look.pulse)} />
        )}
        <span className={styles.sourceName}>
          {isAll ? t('environment.logs.sources.all') : source.label}
        </span>
        {!isAll && <span className={styles.sourceState}>{state}</span>}
      </span>
      {source.detail && (
        <span className={styles.sourceDetail} title={source.detail}>
          {source.detail}
        </span>
      )}
    </button>
  );
}

/**
 * Источники логов: цели «Dev-сервера» и сервисы Compose — двумя группами,
 * подписанными так же, как там, где их запускают.
 */
export function LogSourceList({ info, selectedId, onSelect }: LogSourceListProps) {
  const { t } = useTranslation();
  const id = useId();
  const groups = [
    { key: 'run', title: t('environment.logs.sources.run') },
    { key: 'compose', title: t('environment.logs.sources.compose') },
  ]
    .map((group) => ({
      ...group,
      items: info.sources.filter((source) => source.kind === group.key),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <nav className={styles.sources} aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className={styles.sectionTitle}>
        {t('environment.logs.sources.label')}
      </h3>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.title}>
          <h4 className={styles.groupTitle}>{group.title}</h4>
          <ul className={styles.sourceList}>
            {group.items.map((source) => (
              <li key={source.id}>
                <SourceButton
                  source={source}
                  isSelected={source.id === selectedId}
                  onSelect={() => onSelect(source.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {info.docker === 'missing' && (
        <p className={styles.sub}>{t('environment.logs.sources.dockerMissing')}</p>
      )}
      {info.docker === 'stopped' && (
        <p className={styles.sub}>{t('environment.logs.sources.dockerStopped')}</p>
      )}
    </nav>
  );
}
