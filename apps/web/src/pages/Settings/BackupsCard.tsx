import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Modal } from '@shared/ui/modal';
import { TextField } from '@shared/ui/text-field';
import { formatBytes, formatDate } from '@shared/lib/format';

interface BackupEntry {
  name: string;
  target: string;
  createdAt: string;
  sizeBytes: number;
  canRestore: boolean;
  /** Копия зашифрована — восстановление требует парольную фразу. */
  encrypted: boolean;
}

/** Сколько копий показывать сразу: остальные — по кнопке. */
const VISIBLE = 5;

/**
 * Резервные копии и откат к ним.
 *
 * Копии делались с самого начала, но воспользоваться ими можно было только
 * через проводник — найти нужную метку времени и скопировать поверх оригинала.
 * Откат — как раз то, ради чего копии и существуют, поэтому он здесь.
 */
export function BackupsCard() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<BackupEntry | undefined>(undefined);
  // Отдельно — восстановление зашифрованной копии: нужна парольная фраза.
  const [pendingEncrypted, setPendingEncrypted] = useState<BackupEntry | undefined>(undefined);
  const [passphrase, setPassphrase] = useState('');
  const [passError, setPassError] = useState<string | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);

  const { data } = useQuery({
    queryKey: queryKeys.backups,
    queryFn: async () => {
      const { data: result } = await apiClient.get<{ items: BackupEntry[]; isEnabled: boolean }>(
        '/backups',
      );
      return result;
    },
  });

  const restore = useMutation({
    mutationFn: async (vars: { name: string; passphrase?: string }) => {
      await apiClient.post(`/backups/${encodeURIComponent(vars.name)}/restore`, {
        passphrase: vars.passphrase,
      });
    },
    onSuccess: () => {
      // Откат меняет файл конфигурации целиком — устареть может что угодно.
      setPendingEncrypted(undefined);
      setPassphrase('');
      setPassError(undefined);
      void queryClient.invalidateQueries();
    },
    onError: (error: unknown) => {
      // Неверная фраза приходит понятным сообщением с сервера — показываем в поле.
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      setPassError(message ?? t('settings.backupsDecryptError'));
    },
    meta: { successMessage: 'toasts.restored', silentError: true },
  });

  /** Клик по «Откатить»: зашифрованная копия просит фразу, обычная — подтверждение. */
  const askRestore = (item: BackupEntry): void => {
    if (item.encrypted) {
      setPassphrase('');
      setPassError(undefined);
      setPendingEncrypted(item);
    } else {
      setPending(item);
    }
  };

  const items = data?.items ?? [];
  const shown = showAll ? items : items.slice(0, VISIBLE);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.backupsTitle')}
        </Typography>
        <Typography variant="body-sm" color="muted" className="prose">
          {t('settings.backupsHint')}
        </Typography>

        {items.length === 0 && <Typography color="subtle">{t('settings.backupsEmpty')}</Typography>}

        {shown.map((item) => (
          <Stack
            key={item.name}
            direction="row"
            align="center"
            justify="between"
            gap="var(--spacing-sm)"
            wrap
          >
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Badge tone="neutral">{item.target}</Badge>
              <Typography variant="body-sm" color="muted">
                {formatDate(item.createdAt, i18n.language)} · {formatBytes(item.sizeBytes)}
              </Typography>
            </Stack>

            {/* Восстановить можно копии известных файлов конфигурации и папки
                скиллов (разворачиваются рекурсивно). Для чего откат недоступен —
                причину называем прямо, чтобы не выглядело поломкой. */}
            {item.canRestore ? (
              <Button size="sm" variant="secondary" onClick={() => askRestore(item)}>
                {t('settings.backupsRestore')}
              </Button>
            ) : (
              <Typography variant="caption" color="subtle">
                {t('settings.backupsManual')}
              </Typography>
            )}
          </Stack>
        ))}

        {items.length > VISIBLE && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((current) => !current)}>
            {showAll ? t('common.showLess') : t('common.showAll', { count: items.length })}
          </Button>
        )}
      </Stack>

      {/* Откат перезаписывает рабочий конфиг — спрашиваем, как и при удалении. */}
      <ConfirmDialog
        isOpen={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(undefined)}
        title={t('settings.backupsConfirmTitle')}
        description={t('settings.backupsConfirmText', { target: pending?.target ?? '' })}
        confirmLabel={t('settings.backupsRestore')}
        isPending={restore.isPending}
        onConfirm={() => {
          if (pending) restore.mutate({ name: pending.name });
          setPending(undefined);
        }}
      />

      {/* Зашифрованная копия: сперва просим парольную фразу, потом восстанавливаем. */}
      <Modal
        isOpen={Boolean(pendingEncrypted)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingEncrypted(undefined);
            setPassphrase('');
            setPassError(undefined);
          }
        }}
        title={t('settings.backupsDecryptTitle')}
        description={t('settings.backupsDecryptText', { target: pendingEncrypted?.target ?? '' })}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingEncrypted(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (pendingEncrypted) {
                  restore.mutate({ name: pendingEncrypted.name, passphrase });
                }
              }}
              isLoading={restore.isPending}
              disabled={passphrase.length < 8}
            >
              {t('settings.backupsRestore')}
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
            setPassError(undefined);
          }}
          error={passError}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
