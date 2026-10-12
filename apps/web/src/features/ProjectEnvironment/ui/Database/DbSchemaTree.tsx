import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDbSchema } from '@entities/Database';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { dbErrorView, tableQuery } from '../../lib/dbError';
import type { DbSchemaListProps, DbSchemaTreeProps } from './Database.types';
import styles from './Database.module.scss';

/**
 * Схема базы слева от редактора: таблицы с колонками, поиск по имени таблицы
 * и колонки, и кнопка, которая кладёт в редактор готовый запрос к таблице —
 * имя в кавычках, если без них Postgres его не узнает.
 */
export function DbSchemaTree({ projectPath, connectionId, onInsert }: DbSchemaTreeProps) {
  const { t } = useTranslation();
  const schema = useDbSchema(projectPath, connectionId);
  const [filter, setFilter] = useState('');

  return (
    <section className={styles.schema} aria-labelledby="db-schema-title">
      <div className={styles.schemaHead}>
        <h3 id="db-schema-title" className={styles.sectionTitle}>
          {t('environment.database.schema.title')}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name="refresh" size={16} />}
          aria-label={t('environment.database.schema.refresh')}
          disabled={schema.isFetching}
          onClick={() => void schema.refetch()}
        />
      </div>
      {schema.isPending && <SkeletonList rows={4} />}
      {schema.isError && (
        <p className={styles.error} role="alert">
          {dbErrorView(schema.error, t).message}
        </p>
      )}
      {schema.data && (
        <>
          <p className={styles.sub}>
            {t('environment.database.schema.version', { version: schema.data.serverVersion })} ·{' '}
            {t('environment.database.schema.tables', { count: schema.data.tables.length })}
          </p>
          <SearchField
            value={filter}
            onChange={setFilter}
            label={t('environment.database.schema.filter')}
            placeholder={t('environment.database.schema.filter')}
          />
          <DbSchemaList schema={schema.data} filter={filter} onInsert={onInsert} />
        </>
      )}
    </section>
  );
}

function DbSchemaList({ schema, filter, onInsert }: DbSchemaListProps) {
  const { t } = useTranslation();
  if (schema.tables.length === 0) {
    return <p className={styles.sub}>{t('environment.database.schema.empty')}</p>;
  }
  const needle = filter.trim().toLowerCase();
  const tables = needle
    ? schema.tables.filter(
        (table) =>
          `${table.schema}.${table.name}`.toLowerCase().includes(needle) ||
          table.columns.some((column) => column.name.toLowerCase().includes(needle)),
      )
    : schema.tables;

  return (
    <>
      {tables.length === 0 && (
        <p className={styles.sub}>{t('environment.database.schema.noMatch')}</p>
      )}
      <ul className={styles.tables}>
        {tables.map((table) => {
          const name = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`;
          const pk = new Set(table.primaryKey);
          return (
            <li key={`${table.schema}.${table.name}`}>
              <details className={styles.table}>
                <summary>
                  <span className={styles.tableName}>{name}</span>
                  {table.kind !== 'table' && (
                    <span className={styles.sub}>
                      {t(`environment.database.schema.kinds.${table.kind}`)}
                    </span>
                  )}
                  {table.rowsEstimate >= 0 && (
                    <span className={styles.sub}>
                      {t('environment.database.schema.rows', {
                        count: table.rowsEstimate,
                      })}
                    </span>
                  )}
                </summary>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="play" size={16} />}
                  onClick={() => onInsert(tableQuery(table.schema, table.name))}
                >
                  {t('environment.database.schema.insert', { name })}
                </Button>
                <ul className={styles.columns}>
                  {table.columns.map((column) => (
                    <li key={column.name}>
                      <span className={styles.columnName}>
                        {pk.has(column.name) && (
                          <Icon name="lock" size={12} label={t('environment.database.schema.pk')} />
                        )}
                        {column.name}
                      </span>
                      <span className={styles.columnType}>
                        {column.type}
                        {column.nullable ? '' : ' · NOT NULL'}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
      {schema.truncated && (
        <p className={styles.sub}>{t('environment.database.schema.truncated')}</p>
      )}
    </>
  );
}
