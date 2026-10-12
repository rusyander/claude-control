import { useTranslation } from 'react-i18next';
import { useDbMigrations } from '@entities/Database';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { DbMigrationsProps } from './Database.types';
import styles from './Database.module.scss';

/**
 * Миграции: что лежит в проекте и что из этого применено к выбранной базе.
 * Сворачиваемый блок, но строка заголовка уже говорит главное — «3 не
 * применены», «dirty», — и раскрывается сам, когда есть о чём беспокоиться.
 */
export function DbMigrations({ projectPath, connectionId }: DbMigrationsProps) {
  const { t } = useTranslation();
  const migrations = useDbMigrations(projectPath, connectionId);
  const info = migrations.data;
  if (!info) return null;

  if (!info.tool) {
    return <p className={styles.sub}>{t('environment.database.migrations.none')}</p>;
  }
  const pending = info.migrations.filter((item) => !item.applied).length;
  const known = Boolean(connectionId) && !info.error && !info.neverRun;
  const trouble = Boolean(info.dirty) || info.orphaned.length > 0 || (known && pending > 0);

  return (
    <details className={styles.migrations} open={trouble}>
      <summary>
        <span className={styles.sectionTitle}>{t('environment.database.migrations.title')}</span>
        <span className={styles.sub}>
          {t('environment.database.migrations.where', {
            tool: info.tool,
            dir: info.dir,
            table: info.table,
          })}
        </span>
        {known && (
          <Badge tone={pending > 0 ? 'warning' : 'success'}>
            {pending > 0
              ? t('environment.database.migrations.pending', { count: pending })
              : t('environment.database.migrations.allApplied')}
          </Badge>
        )}
        {info.dirty && <Badge tone="danger">dirty</Badge>}
      </summary>

      {!connectionId && (
        <p className={styles.sub}>{t('environment.database.migrations.filesOnly')}</p>
      )}
      {info.neverRun && (
        <p className={styles.sub}>
          {t('environment.database.migrations.neverRun', { table: info.table })}
        </p>
      )}
      {info.error && (
        <p className={styles.error}>
          {t('environment.database.migrations.readError', { message: info.error })}
        </p>
      )}
      {info.dirty && (
        <p className={styles.notice} data-tone="danger">
          <Icon name="error" size={16} />
          {t('environment.database.migrations.dirty')}
        </p>
      )}
      {info.orphaned.length > 0 && (
        <p className={styles.notice} data-tone="warning">
          <Icon name="warning" size={16} />
          {t('environment.database.migrations.orphaned', { ids: info.orphaned.join(', ') })}
        </p>
      )}
      <ol className={styles.migrationList}>
        {info.migrations.map((item) => (
          <li key={item.id} data-applied={known ? String(item.applied) : undefined}>
            <code>{item.id}</code>
            {known && (
              <span className={styles.sub}>
                {item.applied
                  ? t('environment.database.migrations.applied')
                  : t('environment.database.migrations.notApplied')}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className={styles.sub}>{t('environment.database.migrations.readOnly')}</p>
    </details>
  );
}
