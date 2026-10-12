import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDbMcp } from '@entities/Database';
import { Toggle } from '@shared/ui/toggle';
import { dbErrorView } from '../../lib/dbError';
import type { DbAgentAccessProps, DbUnsupportedListProps } from './Database.types';
import styles from './Database.module.scss';

/**
 * Доступ агента к базе — переключатель с объяснением, что именно он делает:
 * пишет переходник в конфигурацию CLI. Без этого объяснения тумблер «агент
 * видит базу» читается как «агент получит пароль», а это ровно не так.
 */
export function DbAgentAccess({ projectPath, info }: DbAgentAccessProps) {
  const { t } = useTranslation();
  const id = useId();
  const mcp = useDbMcp(projectPath);
  const [failure, setFailure] = useState<string>();

  return (
    <section className={styles.agent} aria-labelledby={`${id}-title`}>
      <div className={styles.agentRow}>
        <h3 id={`${id}-title`} className={styles.sectionTitle}>
          {t('environment.database.agent.title')}
        </h3>
        <Toggle
          checked={info.mcpRegistered}
          disabled={mcp.isPending}
          aria-label={t('environment.database.agent.toggle')}
          onCheckedChange={(checked) => {
            setFailure(undefined);
            mcp.mutate(checked, {
              onError: (error) =>
                setFailure(
                  t('environment.database.errors.mcp', { message: dbErrorView(error, t).message }),
                ),
            });
          }}
        />
        <span className={styles.sub} aria-live="polite">
          {info.mcpRegistered
            ? t('environment.database.agent.on')
            : t('environment.database.agent.off')}
          {mcp.isSuccess ? ` · ${t('environment.database.agent.restart')}` : ''}
        </span>
      </div>
      <p className={styles.sub}>{t('environment.database.agent.text')}</p>
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

/** Базы, которые панель нашла, но читать не может, — с причиной и тем, что сделать. */
export function DbUnsupportedList({ items }: DbUnsupportedListProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <section className={styles.unsupported}>
      <h3 className={styles.sectionTitle}>{t('environment.database.unsupportedTitle')}</h3>
      <ul>
        {items.map((item) => (
          <li key={`${item.origin}-${item.engine}`}>
            {item.reason === 'no-port'
              ? t('environment.database.unsupportedNoPort', { origin: item.origin })
              : t('environment.database.unsupportedEngine', {
                  origin: item.origin,
                  engine: item.engine,
                })}
          </li>
        ))}
      </ul>
    </section>
  );
}
