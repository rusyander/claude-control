import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDbQuery, type DbQueryMode } from '@entities/Database';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { dbErrorView, lineOfPosition, type DbErrorView } from '../../lib/dbError';
import { DbResult } from './DbResult';
import type { DbQueryEditorProps } from './Database.types';
import styles from './Database.module.scss';

/**
 * Редактор запроса и результат. Ctrl+Enter — выполнить, как в любом клиенте
 * базы. Ошибка Postgres с позицией ставит курсор в место ошибки и называет
 * строку: «syntax error at or near» без места заставляет искать глазами.
 * Отказ сторожа подписан отдельно — до базы такой запрос не дошёл.
 */
export function DbQueryEditor({ projectPath, connectionId, sql, onSqlChange }: DbQueryEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const query = useDbQuery();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [failure, setFailure] = useState<DbErrorView & { sql: string }>();

  const run = (mode: DbQueryMode): void => {
    if (!sql.trim() || query.isPending) return;
    setFailure(undefined);
    const sent = sql;
    query.mutate(
      { path: projectPath, connectionId, sql: sent, mode },
      {
        onError: (error) => {
          const view = dbErrorView(error, t);
          setFailure({ ...view, sql: sent });
          if (view.position && editorRef.current) {
            editorRef.current.focus();
            editorRef.current.setSelectionRange(view.position - 1, view.position);
          }
        },
      },
    );
  };

  return (
    <section className={styles.editor} aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} htmlFor={id} className={styles.sectionTitle}>
        {t('environment.database.editor.label')}
      </label>
      <textarea
        id={id}
        ref={editorRef}
        className={styles.sql}
        value={sql}
        rows={7}
        spellCheck={false}
        placeholder={t('environment.database.editor.placeholder')}
        aria-describedby={`${id}-limits`}
        onChange={(event) => onSqlChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            run('run');
          }
        }}
      />
      <div className={styles.editorBar}>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="play" size={16} />}
          isLoading={query.isPending && query.variables?.mode === 'run'}
          disabled={!sql.trim() || query.isPending}
          onClick={() => run('run')}
          title={t('environment.database.editor.runShortcut')}
        >
          {t('environment.database.editor.run')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          isLoading={query.isPending && query.variables?.mode === 'explain'}
          disabled={!sql.trim() || query.isPending}
          onClick={() => run('explain')}
        >
          {t('environment.database.editor.explain')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          isLoading={query.isPending && query.variables?.mode === 'explain-analyze'}
          disabled={!sql.trim() || query.isPending}
          onClick={() => run('explain-analyze')}
          title={t('environment.database.editor.explainAnalyzeHint')}
        >
          {t('environment.database.editor.explainAnalyze')}
        </Button>
        <span id={`${id}-limits`} className={styles.sub}>
          <kbd>{t('environment.database.editor.runShortcut')}</kbd> ·{' '}
          {t('environment.database.editor.limits')}
        </span>
      </div>

      <div aria-live="polite" className={styles.resultArea}>
        {query.isPending && (
          <p className={styles.sub}>{t('environment.database.editor.running')}</p>
        )}
        {failure && (
          <div className={styles.notice} data-tone="danger" role="alert">
            <p className={styles.noticeTitle}>
              <Icon name="error" size={16} />
              {failure.refused ? t('environment.database.refused.title') : failure.message}
            </p>
            {failure.refused && <p>{failure.message}</p>}
            {failure.position && (
              <p className={styles.sub}>
                {t('environment.database.errors.position', {
                  position: failure.position,
                  line: lineOfPosition(failure.sql, failure.position),
                })}
                {failure.sqlState ? ` · SQLSTATE ${failure.sqlState}` : ''}
              </p>
            )}
            {failure.hint && <p>{failure.hint}</p>}
          </div>
        )}
        {!query.isPending && !failure && query.data && <DbResult result={query.data} />}
      </div>
    </section>
  );
}
