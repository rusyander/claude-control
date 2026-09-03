import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { toErrorMessage } from '@shared/api/client';
import {
  CREDENTIALS_TEMPLATES,
  useSaveCredentials,
  type CredentialsTemplateKind,
} from '@entities/Credentials';
import type { CredentialsFormModalProps } from './CredentialsFormModal.types';
import styles from './CredentialsFormModal.module.scss';

const TEMPLATE_KINDS: CredentialsTemplateKind[] = ['oauth', 'apiKey', 'readFrom'];

/**
 * Форма ручного доступа Claude Code: три образца (токен подписки, ключ API,
 * свой файл) и одно поле JSON. Ошибка проверки с сервера — «не JSON», «файл не
 * найден», «это каталог» — показывается у поля, окно при этом остаётся открытым.
 *
 * Одна форма на два места: карточку «Настроек» и мастер первого запуска.
 * Значение никуда не логируется и в кеш не попадает — только в запрос.
 */
export function CredentialsFormModal({ isOpen, onOpenChange }: CredentialsFormModalProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string>(CREDENTIALS_TEMPLATES.oauth);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useSaveCredentials();

  // Каждое открытие начинается с чистого образца: чужой недописанный JSON и
  // прошлая ошибка не должны встречать следующего входа.
  useEffect(() => {
    if (isOpen) {
      setValue(CREDENTIALS_TEMPLATES.oauth);
      setError(undefined);
    }
  }, [isOpen]);

  const submit = (): void => {
    save.mutate(value, {
      onSuccess: () => {
        setError(undefined);
        onOpenChange(false);
      },
      onError: (mutationError) => setError(toErrorMessage(mutationError)),
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('credentials.manualTitle')}
      description={t('credentials.manualHint')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} isLoading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {t('credentials.templates')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {TEMPLATE_KINDS.map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="ghost"
                onClick={() => {
                  setValue(CREDENTIALS_TEMPLATES[kind]);
                  setError(undefined);
                }}
              >
                {t(`credentials.template_${kind}`)}
              </Button>
            ))}
          </Stack>
        </Stack>

        <TextField
          label={t('credentials.jsonLabel')}
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(undefined);
          }}
          multiline
          rows={12}
          isMono
          error={error}
          hint={t('credentials.jsonHint')}
        />

        <Typography variant="caption" color="subtle" className={styles.warning}>
          {t('credentials.securityNote')}
        </Typography>
      </Stack>
    </Modal>
  );
}
