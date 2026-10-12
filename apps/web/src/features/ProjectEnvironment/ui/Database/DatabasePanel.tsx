import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDbConnections, useRemoveDbConnection, type DbConnection } from '@entities/Database';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { dbErrorCode, dbErrorView } from '../../lib/dbError';
import { DbAgentAccess, DbUnsupportedList } from './DbAgentAccess';
import { DbConnectionBar } from './DbConnectionBar';
import { DbConnectionForm } from './DbConnectionForm';
import { DbMigrations } from './DbMigrations';
import { DbQueryEditor } from './DbQueryEditor';
import { DbSchemaTree } from './DbSchemaTree';
import type { DatabasePanelProps } from './Database.types';
import styles from './Database.module.scss';

type FormState = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; connection: DbConnection };

/**
 * Вкладка «База данных»: подключения проекта, схема, запрос чтения, миграции и
 * доступ агента. Выбранное подключение и текст запроса живут здесь, а не в
 * дочерних блоках: смена подключения сбрасывает схему, но не стирает запрос.
 */
export function DatabasePanel({ projectPath, isOpen, onShowServices }: DatabasePanelProps) {
  const { t } = useTranslation();
  const connections = useDbConnections(projectPath, isOpen);
  const remove = useRemoveDbConnection();
  const [chosenId, setChosenId] = useState<string>();
  const [form, setForm] = useState<FormState>({ mode: 'closed' });
  const [removing, setRemoving] = useState<DbConnection>();
  const [sql, setSql] = useState('');
  const [failure, setFailure] = useState<string>();

  if (connections.isPending) return <SkeletonList rows={3} withActions />;
  if (connections.isError) {
    if (dbErrorCode(connections.error) === 'db-project-unregistered') {
      return (
        <EmptyState
          icon="database"
          title={t('environment.database.empty.title')}
          text={t('environment.database.errors.unregistered')}
        />
      );
    }
    return <LoadErrorCard onRetry={() => void connections.refetch()} />;
  }

  const info = connections.data;
  const list = info.connections;
  const selected = list.find((item) => item.id === chosenId) ?? list[0];
  const formBlock =
    form.mode === 'closed' ? null : (
      <DbConnectionForm
        projectPath={projectPath}
        {...(form.mode === 'edit' ? { editing: form.connection } : {})}
        onDone={(savedId) => {
          setForm({ mode: 'closed' });
          if (savedId) setChosenId(savedId);
        }}
      />
    );

  if (list.length === 0) {
    return (
      <div className={styles.block}>
        {form.mode === 'closed' ? (
          <EmptyState
            icon="database"
            title={t('environment.database.empty.title')}
            text={t('environment.database.empty.text')}
            action={
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="plus" size={16} />}
                onClick={() => setForm({ mode: 'new' })}
              >
                {t('environment.database.add')}
              </Button>
            }
          />
        ) : (
          formBlock
        )}
        <DbUnsupportedList items={info.unsupported} />
        <DbMigrations projectPath={projectPath} connectionId={undefined} />
      </div>
    );
  }

  const composeDown =
    selected?.composeService && selected.composeState && selected.composeState !== 'running';

  return (
    <div className={styles.block}>
      <DbConnectionBar
        connections={list}
        selected={selected}
        onSelect={setChosenId}
        onAdd={() => setForm({ mode: 'new' })}
        onEdit={(connection) => setForm({ mode: 'edit', connection })}
        onRemove={setRemoving}
      />
      {formBlock}
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
      {composeDown && selected && (
        <div className={styles.notice} data-tone="warning" role="status">
          <p className={styles.noticeTitle}>
            <Icon name="warning" size={16} />
            {t('environment.database.composeDown', {
              service: selected.composeService,
              state: t(
                `environment.state.${selected.composeState === 'exited' ? 'stopped' : selected.composeState}`,
              ),
            })}
          </p>
          <div>
            <Button variant="secondary" size="sm" onClick={onShowServices}>
              {t('environment.database.toServices')}
            </Button>
          </div>
        </div>
      )}

      {selected && (
        <div className={styles.workspace}>
          <DbSchemaTree
            key={selected.id}
            projectPath={projectPath}
            connectionId={selected.id}
            onInsert={setSql}
          />
          <DbQueryEditor
            key={`editor-${selected.id}`}
            projectPath={projectPath}
            connectionId={selected.id}
            sql={sql}
            onSqlChange={setSql}
          />
        </div>
      )}

      <DbMigrations projectPath={projectPath} connectionId={selected?.id} />
      <DbUnsupportedList items={info.unsupported} />
      <DbAgentAccess projectPath={projectPath} info={info} />

      <ConfirmDialog
        isOpen={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        onConfirm={() => {
          if (!removing) return;
          const target = removing;
          setRemoving(undefined);
          setFailure(undefined);
          remove.mutate(
            { path: projectPath, id: target.id },
            {
              onSuccess: () => setChosenId(undefined),
              onError: (error) => setFailure(dbErrorView(error, t).message),
            },
          );
        }}
        title={t('environment.database.removeTitle', { label: removing?.label ?? '' })}
        description={t('environment.database.removeText')}
        confirmLabel={t('environment.database.remove')}
      />
    </div>
  );
}
