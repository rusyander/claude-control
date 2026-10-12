import { useTranslation } from 'react-i18next';
import type { DbQueryResult } from '@entities/Database';
import styles from './Database.module.scss';

/**
 * Результат: таблица с типом под именем колонки, NULL отличим от пустой
 * строки, обрезка названа вслух. План EXPLAIN — моноширинным текстом, как его
 * печатает Postgres: отступы в нём и есть дерево.
 */
export function DbResult({ result }: { result: DbQueryResult }) {
  const { t } = useTranslation();

  if (result.plan !== undefined) {
    return (
      <div className={styles.result}>
        <p className={styles.sub}>
          {t('environment.database.result.planTime', { ms: result.durationMs })}
        </p>
        <pre className={styles.plan} aria-label={t('environment.database.result.plan')}>
          {result.plan}
        </pre>
      </div>
    );
  }

  return (
    <div className={styles.result}>
      <p className={styles.sub}>
        {t('environment.database.result.summary', {
          count: result.rows.length,
          ms: result.durationMs,
        })}
      </p>
      {result.truncated && (
        <p className={styles.notice} data-tone="warning">
          {t('environment.database.result.truncated', { count: result.rows.length })}
        </p>
      )}
      {result.rows.length === 0 ? (
        <p className={styles.sub}>{t('environment.database.result.empty')}</p>
      ) : (
        <div
          className={styles.gridWrap}
          tabIndex={0}
          role="region"
          aria-label={t('environment.database.result.caption')}
        >
          <table className={styles.grid}>
            <thead>
              <tr>
                {result.columns.map((column, index) => (
                  <th key={`${column.name}-${index}`} scope="col">
                    <span className={styles.colName}>{column.name}</span>
                    <span className={styles.colType}>{column.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((value, cellIndex) => (
                    <td key={cellIndex}>
                      {value === null ? <span className={styles.null}>NULL</span> : value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
