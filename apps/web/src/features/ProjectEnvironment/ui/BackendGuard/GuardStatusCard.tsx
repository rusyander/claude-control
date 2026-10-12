import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { GuardStatusCardProps } from './BackendGuard.types';
import styles from './BackendGuard.module.scss';

const TONE: Record<GuardStatusCardProps['status']['state'], BadgeTone> = {
  none: 'neutral',
  installed: 'success',
  partial: 'warning',
};

/**
 * Что стоит и где: состояние, группа панели и поимённо файлы в `.claude/`
 * проекта. Файлы названы путями — защита живёт в проекте, а не в панели, и
 * человек должен знать, что коммитить и что смотреть в ревью.
 */
export function GuardStatusCard({ status, isBusy, onRestore }: GuardStatusCardProps) {
  const { t } = useTranslation();
  const { state, parts, files } = status;
  const rows = [
    { key: 'script', path: files.script, state: parts.script },
    { key: 'hook', path: files.settings, state: parts.hook },
    { key: 'rule', path: files.rule, state: parts.rule },
  ] as const;

  return (
    <section className={styles.status} aria-labelledby="guard-status-title">
      <div className={styles.statusHead}>
        <h3 id="guard-status-title" className={styles.statusTitle}>
          <Icon name="lock" size={16} />
          {t('environment.guard.title')}
        </h3>
        <Badge tone={TONE[state]} withDot>
          {t(`environment.guard.state.${state}`)}
        </Badge>
        {status.groupName && (
          <span className={styles.sub}>
            {t('environment.guard.group', { name: status.groupName })}
          </span>
        )}
      </div>

      {state === 'partial' ? (
        <div className={styles.partial} role="note">
          <p>
            <Icon name="warning" size={16} />
            {t('environment.guard.partialText')}
          </p>
          <Button variant="secondary" size="sm" disabled={isBusy} onClick={onRestore}>
            {t('environment.guard.actions.restore')}
          </Button>
        </div>
      ) : (
        <p className={styles.text}>
          {t(state === 'none' ? 'environment.guard.noneText' : 'environment.guard.installedText')}
        </p>
      )}

      {state !== 'none' && (
        <div className={styles.block}>
          <h4 className={styles.filesTitle}>{t('environment.guard.filesTitle')}</h4>
          <ul className={styles.files}>
            {rows.map((row) => (
              <li key={row.key} data-state={row.state}>
                <span className={styles.fileName}>{row.path}</span>
                <span className={styles.sub}>{t(`environment.guard.parts.${row.key}`)}</span>
                <span className={styles.partState}>
                  {t(`environment.guard.partState.${row.state}`)}
                </span>
              </li>
            ))}
            <li data-state="ok">
              <span className={styles.fileName}>{files.config}</span>
              <span className={styles.sub}>{t('environment.guard.parts.config')}</span>
            </li>
          </ul>
          <p className={styles.sub}>{t('environment.guard.shareHint')}</p>
        </div>
      )}

      <p className={styles.note}>
        <Icon name="info" size={16} />
        {t('environment.guard.claudeOnly')}
      </p>
    </section>
  );
}
