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
import { formatBytes, formatDate } from '@shared/lib/format';

interface BackupEntry {
  name: string;
  target: string;
  createdAt: string;
  sizeBytes: number;
  canRestore: boolean;
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
    mutationFn: async (name: string) => {
      await apiClient.post(`/backups/${encodeURIComponent(name)}/restore`);
    },
    onSuccess: () => {
      // Откат меняет файл конфигурации целиком — устареть может что угодно.
      void queryClient.invalidateQueries();
    },
    meta: { successMessage: 'toasts.restored' },
  });

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

            {/* Папку скилла копированием файла не вернуть — кнопку не рисуем,
                а причину называем прямо, чтобы не выглядело поломкой. */}
            {item.canRestore ? (
              <Button size="sm" variant="secondary" onClick={() => setPending(item)}>
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
          if (pending) restore.mutate(pending.name);
          setPending(undefined);
        }}
      />
    </Card>
  );
}
