import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { TextField } from '@shared/ui/text-field';
import { useSettings } from '@entities/AppConfig';

/**
 * Шифрование резервных копий файла секретов `.mcp-secrets.env`.
 *
 * По умолчанию копии секретов лежат открытым текстом рядом с токенами. Здесь их
 * можно шифровать: копия пишется зашифрованной (AES-256-GCM, ключ из парольной
 * фразы). Сама фраза НЕ хранится — держится только в памяти сервера и
 * запрашивается при включении. После перезапуска сервера её надо ввести заново,
 * иначе новые копии секретов не создаются (открытым текстом писать нельзя).
 */
interface BackupsStatus {
  encryptSecrets: boolean;
  passphraseLoaded: boolean;
  hasPassphrase: boolean;
}

export function SecretEncryptionCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();

  const [isOpen, setIsOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const status = useQuery({
    queryKey: queryKeys.backups,
    queryFn: async () => {
      const { data } = await apiClient.get<BackupsStatus>('/backups');
      return data;
    },
  });

  // Включение и повторный ввод фразы идут одним запросом: фраза уходит на сервер
  // (в память), verifier сверяется, режим при необходимости включается.
  const setPass = useMutation({
    mutationFn: async () => {
      await apiClient.post('/backups/secret-passphrase', { passphrase, enable: true });
    },
    onSuccess: () => {
      setIsOpen(false);
      setPassphrase('');
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups });
    },
    onError: (mutationError: unknown) => {
      const message = (mutationError as { response?: { data?: { error?: string } } })?.response
        ?.data?.error;
      setError(message ?? t('settings.encryptSecretsError'));
    },
    meta: { silentError: true },
  });

  // Выключение — обычным PATCH: фразу не трогаем, verifier остаётся (при
  // повторном включении фраза должна совпасть с прежней).
  const disable = useMutation({
    mutationFn: async () => {
      await apiClient.patch('/settings', { encryptSecretBackups: false });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups });
    },
  });

  if (!settings) return null;

  const enabled = settings.encryptSecretBackups;
  // Включено, но фраза не в памяти (например, после перезапуска сервера) —
  // копии секретов сейчас не создаются, пока фразу не введут заново.
  const needsPassphrase = enabled && status.data?.passphraseLoaded === false;

  const openModal = (): void => {
    setPassphrase('');
    setError(undefined);
    setIsOpen(true);
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)" style={{ maxWidth: 'var(--text-measure)' }}>
            <Typography variant="body-sm" as="span">
              {t('settings.encryptSecrets')}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t('settings.encryptSecretsHint')}
            </Typography>
          </Stack>
          <Toggle
            checked={enabled}
            onCheckedChange={(next) => (next ? openModal() : disable.mutate())}
            aria-label={t('settings.encryptSecrets')}
          />
        </Stack>

        {needsPassphrase && (
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Typography variant="caption" color="warning" className="prose">
              {t('settings.encryptSecretsNeedsPass')}
            </Typography>
            <Button size="sm" variant="secondary" onClick={openModal}>
              {t('settings.encryptSecretsEnterPass')}
            </Button>
          </Stack>
        )}
      </Stack>

      <Modal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        title={t('settings.encryptSecretsPassTitle')}
        description={
          status.data?.hasPassphrase
            ? t('settings.encryptSecretsPassExisting')
            : t('settings.encryptSecretsPassNew')
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => setPass.mutate()}
              isLoading={setPass.isPending}
              disabled={passphrase.length < 8}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('settings.encryptSecretsPassLabel')}
          type="password"
          value={passphrase}
          onChange={(next) => {
            setPassphrase(next);
            setError(undefined);
          }}
          hint={t('settings.encryptSecretsPassHint')}
          error={error}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
