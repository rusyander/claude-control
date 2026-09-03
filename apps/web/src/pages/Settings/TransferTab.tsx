import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { EnvTransferCard } from './EnvTransferCard';
import { exportPanelState, importPanelState } from './model/transfer';
import styles from './SettingsPage.module.scss';

/**
 * Раздел «Перенос»: снимок настроек самой панели и перенос окружения провайдера
 * на другую машину. Снимок идёт первым — он мельче и объясняет разницу: панель
 * это её собственное состояние, окружение — настоящие файлы CLI.
 */
export function TransferTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const importState = async (file: File): Promise<void> => {
    try {
      await importPanelState(file, queryClient);
      toast.success(t('settings.transferImported'));
    } catch {
      toast.error(t('settings.transferImportError'));
    }
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.transferTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle" className={styles.hint}>
            {t('settings.transferHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="file" size={18} />}
              onClick={() => void exportPanelState()}
            >
              {t('settings.transferExport')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="file" size={18} />}
              onClick={() => fileRef.current?.click()}
            >
              {t('settings.transferImport')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importState(file);
                event.target.value = '';
              }}
            />
          </Stack>
        </Stack>
      </Card>

      {/* Перенос окружения: конфигурация ЛЮБОГО провайдера архивом на другую
          машину. Шире снимка выше — это настоящие файлы Claude Code и других
          CLI, а не состояние панели. */}
      <EnvTransferCard />
    </Stack>
  );
}
