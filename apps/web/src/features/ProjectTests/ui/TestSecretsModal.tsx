import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { toErrorMessage } from '@shared/api/client';
import { useEnvSecrets, useRemoveEnvSecret, useSaveEnvSecret } from '@entities/ProjectTest';
import type { TestSecretsModalProps } from './TestSecretsModal.types';
import styles from './ProjectTests.module.scss';

/**
 * Доступы стенда: логин, пароль, токен — то, без чего прогон против настоящего
 * окружения упирается в форму входа.
 *
 * Окно устроено вокруг одного правила: значение сюда ВВОДЯТ, но отсюда его не
 * читают. Сервер отдаёт маску и признак «задан», поэтому сохранённый пароль в
 * поле не подставляется — его можно заменить или забыть, но не подсмотреть.
 *
 * Имя переменной уезжает в файл проекта и живёт в git, значение — только в
 * панели этой машины. Поэтому объявленное имя без значения — законное
 * состояние: коллега, склонировавший репозиторий, видит, чего ему не хватает.
 */
export function TestSecretsModal({
  isOpen,
  onOpenChange,
  path,
  environment,
}: TestSecretsModalProps) {
  const { t } = useTranslation();

  const secrets = useEnvSecrets(path, isOpen ? environment.id : undefined);
  const save = useSaveEnvSecret(path);
  const remove = useRemoveEnvSecret(path);

  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  /** Какому доступу сейчас меняют значение: пустая строка — никакому. */
  const [editing, setEditing] = useState('');
  const [editingValue, setEditingValue] = useState('');
  const [error, setError] = useState<string | undefined>();

  const items = secrets.data?.secrets ?? [];

  const send = async (action: () => Promise<unknown>): Promise<void> => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const add = (): Promise<void> =>
    send(async () => {
      await save.mutateAsync({
        environmentId: environment.id,
        name: name.trim(),
        title: title.trim() || undefined,
        value,
      });
      setName('');
      setTitle('');
      setValue('');
    });

  const replace = (secretName: string): Promise<void> =>
    send(async () => {
      await save.mutateAsync({
        environmentId: environment.id,
        name: secretName,
        value: editingValue,
      });
      setEditing('');
      setEditingValue('');
    });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('tests.secrets.title', { environment: environment.title })}
      description={t('tests.secrets.hint')}
      size="md"
    >
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-2xs)">
          {/* «Доступов нет» — только когда ответ пришёл: пока список грузится,
              та же подпись врёт человеку, у которого доступы давно заданы. */}
          {secrets.data && items.length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('tests.secrets.empty')}
            </Typography>
          )}

          {items.map((secret) => (
            <Stack key={secret.name} gap="var(--spacing-3xs)" className={styles.secretRow}>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography variant="mono" weight="medium" as="span">
                  {secret.name}
                </Typography>
                {secret.hasValue ? (
                  <Badge tone="success">{t('tests.secrets.set', { masked: secret.masked })}</Badge>
                ) : (
                  <Badge tone="warning">{t('tests.secrets.unset')}</Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(editing === secret.name ? '' : secret.name);
                    setEditingValue('');
                  }}
                >
                  {secret.hasValue ? t('tests.secrets.replace') : t('tests.secrets.fill')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="trash" size={16} />}
                  isLoading={remove.isPending}
                  title={t('tests.secrets.forgetHint')}
                  onClick={() =>
                    void send(() =>
                      remove.mutateAsync({ environmentId: environment.id, name: secret.name }),
                    )
                  }
                >
                  {t('tests.secrets.forget')}
                </Button>
              </Stack>

              {/* Подпись «зачем» — отдельной строкой: в ряду с кнопками она
                  первой уезжает на перенос и разрывает его пополам. */}
              {secret.title && (
                <Typography variant="caption" color="subtle">
                  {secret.title}
                </Typography>
              )}

              {editing === secret.name && (
                <Stack direction="row" gap="var(--spacing-2xs)" align="end" wrap>
                  <div className={styles.halfField}>
                    <TextField
                      label={t('tests.secrets.value')}
                      hint={t('tests.secrets.valueHint')}
                      type="password"
                      value={editingValue}
                      onChange={setEditingValue}
                      autoFocus
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    isLoading={save.isPending}
                    disabled={editingValue.length === 0}
                    onClick={() => void replace(secret.name)}
                  >
                    {t('tests.secrets.save')}
                  </Button>
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.secrets.add')}
          </Typography>
          {/* Два ряда, а не один: подсказки под полями разной высоты, и в общем
              ряду подписи расходятся по вертикали. */}
          <Stack direction="row" gap="var(--spacing-xs)" align="start" wrap>
            <div className={styles.halfField}>
              <TextField
                label={t('tests.secrets.name')}
                placeholder="STAND_PASSWORD"
                hint={t('tests.secrets.nameHint')}
                value={name}
                onChange={setName}
                isMono
              />
            </div>
            <div className={styles.halfField}>
              <TextField
                label={t('tests.secrets.note')}
                hint={t('tests.secrets.noteHint')}
                value={title}
                onChange={setTitle}
              />
            </div>
          </Stack>
          <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
            <div className={styles.halfField}>
              <TextField
                label={t('tests.secrets.value')}
                hint={t('tests.secrets.valueHint')}
                type="password"
                value={value}
                onChange={setValue}
              />
            </div>
            <Button
              variant="primary"
              isLoading={save.isPending}
              disabled={name.trim().length === 0}
              onClick={() => void add()}
            >
              {t('tests.secrets.save')}
            </Button>
          </Stack>
        </Stack>

        {error && (
          <Typography variant="caption" color="danger">
            {error}
          </Typography>
        )}

        <Typography variant="caption" color="subtle">
          {t('tests.secrets.where')}
        </Typography>
      </Stack>
    </Modal>
  );
}
