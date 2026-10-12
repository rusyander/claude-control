import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveDbConnection } from '@entities/Database';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { dbErrorView } from '../../lib/dbError';
import type { DbConnectionFormProps } from './Database.types';
import styles from './Database.module.scss';

type Field = 'label' | 'host' | 'port' | 'database' | 'user';

/**
 * Своё подключение — формой прямо во вкладке, без второго окна поверх окна.
 * Пароль при правке не показывается и не подставляется: пустое поле значит
 * «оставить прежний», и это сказано под полем.
 */
export function DbConnectionForm({ projectPath, editing, onDone }: DbConnectionFormProps) {
  const { t } = useTranslation();
  const save = useSaveDbConnection();
  const [values, setValues] = useState<Record<Field, string>>({
    label: editing?.label ?? '',
    host: editing?.host ?? 'localhost',
    port: String(editing?.port ?? 5432),
    database: editing?.database ?? '',
    user: editing?.user ?? '',
  });
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string>();

  const set = (field: Field) => (value: string) => setValues((old) => ({ ...old, [field]: value }));
  const port = Number(values.port);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65_535;
  const errorOf = (field: Field): string | undefined => {
    if (!touched) return undefined;
    if (!values[field].trim()) return t('environment.database.form.required');
    if (field === 'port' && !portValid) return t('environment.database.form.portInvalid');
    return undefined;
  };
  const fields: Field[] = ['label', 'host', 'port', 'database', 'user'];

  const submit = (): void => {
    setTouched(true);
    setFailure(undefined);
    if (fields.some((field) => !values[field].trim()) || !portValid) return;
    save.mutate(
      {
        path: projectPath,
        ...(editing ? { id: editing.id } : {}),
        label: values.label.trim(),
        host: values.host.trim(),
        port,
        database: values.database.trim(),
        user: values.user.trim(),
        ...(password ? { password } : {}),
      },
      {
        onSuccess: (data) => onDone(data.savedId),
        onError: (error) => setFailure(dbErrorView(error, t).message),
      },
    );
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <h3 className={styles.formTitle}>
        {editing
          ? t('environment.database.form.titleEdit', { label: editing.label })
          : t('environment.database.form.titleNew')}
      </h3>
      <div className={styles.formGrid}>
        <TextField
          label={t('environment.database.form.label')}
          value={values.label}
          onChange={set('label')}
          hint={t('environment.database.form.labelHint')}
          error={errorOf('label')}
          autoFocus
        />
        <TextField
          label={t('environment.database.form.host')}
          value={values.host}
          onChange={set('host')}
          error={errorOf('host')}
          isMono
        />
        <TextField
          label={t('environment.database.form.port')}
          value={values.port}
          onChange={set('port')}
          error={errorOf('port')}
          isMono
        />
        <TextField
          label={t('environment.database.form.database')}
          value={values.database}
          onChange={set('database')}
          error={errorOf('database')}
          isMono
        />
        <TextField
          label={t('environment.database.form.user')}
          value={values.user}
          onChange={set('user')}
          error={errorOf('user')}
          isMono
        />
        <TextField
          label={t('environment.database.form.password')}
          value={password}
          onChange={setPassword}
          type="password"
          hint={
            editing?.hasPassword
              ? `${t('environment.database.form.passwordKeep')} ${t('environment.database.form.passwordHint')}`
              : t('environment.database.form.passwordHint')
          }
        />
      </div>
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" size="sm" isLoading={save.isPending}>
          {t('environment.database.form.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone()}>
          {t('environment.database.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
