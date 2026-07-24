import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderEnvVar } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';

interface ProviderEnvFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Правимая переменная (undefined → создание новой). */
  envVar?: ProviderEnvVar;
  /** Уже существующие ключи — чтобы не допустить дубликат при создании. */
  existingKeys: string[];
  onSubmit: (draft: ProviderEnvVar) => void;
  isPending: boolean;
}

/**
 * Добавление и правка переменной окружения универсальной модели (Codex). Простой
 * KV: имя ключа и значение. Богатая страница Claude (источники settings/local/
 * secrets, маскирование, перенос) здесь ни при чём — это базовый субсет.
 */
export function ProviderEnvForm({
  isOpen,
  onOpenChange,
  envVar,
  existingKeys,
  onSubmit,
  isPending,
}: ProviderEnvFormProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setKey(envVar?.key ?? '');
    setValue(envVar?.value ?? '');
  }, [isOpen, envVar]);

  const trimmedKey = key.trim();
  // При создании — новый ключ не должен совпадать с существующим; при правке
  // ключ можно оставить прежним, но нельзя занять чужой.
  const isDuplicate =
    trimmedKey.length > 0 && trimmedKey !== envVar?.key && existingKeys.includes(trimmedKey);
  const canSave = trimmedKey.length > 0 && !isDuplicate && !isPending;

  const handleSave = (): void => {
    onSubmit({ key: trimmedKey, value });
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={envVar ? `${t('common.edit')}: ${envVar.key}` : t('providerEnv.addVar')}
      description={t('common.needsRestart')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <TextField
          label={t('providerEnv.key')}
          value={key}
          onChange={setKey}
          placeholder="NO_COLOR"
          isMono
          autoFocus={!envVar}
        />
        <TextField
          label={t('providerEnv.value')}
          value={value}
          onChange={setValue}
          placeholder="1"
          isMono
        />
        {isDuplicate && (
          <Typography variant="body-sm" color="danger">
            {t('providerEnv.duplicateKey', { key: trimmedKey })}
          </Typography>
        )}
      </Stack>
    </Modal>
  );
}
