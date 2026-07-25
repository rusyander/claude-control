import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { apiClient, toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { useProviders } from '@entities/Provider';
import { FolderPicker } from '@features/FolderPicker';
import { EnvTransferExportModal } from './EnvTransferExportModal';
import { EnvTransferImportModal } from './EnvTransferImportModal';
import type {
  EnvTransferExportResult,
  EnvTransferPlan,
  EnvTransferPreview,
} from './EnvTransfer.types';
import styles from './EnvTransferCard.module.scss';

/**
 * Перенос окружения: конфигурация ЛЮБОГО провайдера уезжает одним архивом и
 * разворачивается на другой машине.
 *
 * Кнопки стоят у каждого провайдера, а не у активного: пользователь переносит
 * то окружение, которое ему нужно, не переключая панель. Экспорт всегда идёт
 * через предпросмотр («что уедет и чего в архиве не будет»), а импорт — через
 * план («что новое, что уже такое же, что перезапишется»): архив меняет живые
 * файлы, и молча этого делать нельзя.
 *
 * Секретов в архиве нет по устройству — вместо них чек-лист «что ввести
 * руками». Об этом сказано прямо в карточке, иначе на новой машине отсутствие
 * ключей выглядело бы поломкой.
 */
export function EnvTransferCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: providers } = useProviders();

  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<EnvTransferPreview | undefined>(undefined);
  const [exported, setExported] = useState<EnvTransferExportResult | undefined>(undefined);
  const [plan, setPlan] = useState<EnvTransferPlan | undefined>(undefined);
  /** Провайдер, для которого сейчас выбирают папку (экспорт) или архив (импорт). */
  const [pickerFor, setPickerFor] = useState<{ id: string; mode: 'dir' | 'file' } | undefined>(
    undefined,
  );
  /** Путь архива, для которого построен план, — нужен на шаге применения. */
  const [archivePath, setArchivePath] = useState<string | undefined>(undefined);

  const openExport = async (providerId: string): Promise<void> => {
    setBusyId(providerId);
    try {
      const { data } = await apiClient.get<EnvTransferPreview>('/env-transfer/preview', {
        params: { provider: providerId },
      });
      setPreview(data);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const runExport = async (providerId: string, targetDir: string): Promise<void> => {
    setBusyId(providerId);
    try {
      const { data } = await apiClient.post<EnvTransferExportResult>('/env-transfer/export', {
        provider: providerId,
        targetDir,
      });
      setPreview(undefined);
      setExported(data);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const buildPlan = async (providerId: string, path: string): Promise<void> => {
    setBusyId(providerId);
    try {
      const { data } = await apiClient.post<EnvTransferPlan>('/env-transfer/import/plan', {
        provider: providerId,
        archivePath: path,
      });
      setArchivePath(path);
      setPlan(data);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const applyPlan = async (selection: string[]): Promise<void> => {
    if (!plan || !archivePath) return;
    setBusyId(plan.provider.id);
    try {
      await apiClient.post('/env-transfer/import/apply', {
        provider: plan.provider.id,
        archivePath,
        selection,
      });
      await queryClient.invalidateQueries();
      toast.success(t('envTransfer.importDone', { count: selection.length }));
      setPlan(undefined);
      setArchivePath(undefined);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const onPick = (path: string): void => {
    const target = pickerFor;
    setPickerFor(undefined);
    if (!target) return;
    if (target.mode === 'dir') void runExport(target.id, path);
    else void buildPlan(target.id, path);
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('envTransfer.title')}
        </Typography>
        <Typography variant="body-sm" color="subtle" className="prose">
          {t('envTransfer.hint')}
        </Typography>

        <Stack gap="var(--spacing-2xs)">
          {providers?.providers.map((provider) => (
            <Stack
              key={provider.id}
              direction="row"
              align="center"
              gap="var(--spacing-xs)"
              className={styles.row}
            >
              <Typography variant="body-sm" as="span" truncate className={styles.name}>
                {provider.name}
              </Typography>
              {provider.id === providers.active && (
                <Badge tone="accent">{t('envTransfer.activeBadge')}</Badge>
              )}
              <Stack direction="row" gap="var(--spacing-3xs)" className={styles.actions}>
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={busyId === provider.id}
                  leftIcon={<Icon name="file" size={16} />}
                  onClick={() => void openExport(provider.id)}
                >
                  {t('envTransfer.export')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="swap" size={16} />}
                  onClick={() => setPickerFor({ id: provider.id, mode: 'file' })}
                >
                  {t('envTransfer.import')}
                </Button>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Stack>

      <EnvTransferExportModal
        preview={preview}
        result={exported}
        isBusy={Boolean(busyId)}
        onChooseFolder={() => preview && setPickerFor({ id: preview.provider.id, mode: 'dir' })}
        onClose={() => {
          setPreview(undefined);
          setExported(undefined);
        }}
      />

      <EnvTransferImportModal
        plan={plan}
        isBusy={Boolean(busyId)}
        onApply={(selection) => void applyPlan(selection)}
        onClose={() => {
          setPlan(undefined);
          setArchivePath(undefined);
        }}
      />

      <FolderPicker
        isOpen={Boolean(pickerFor)}
        onOpenChange={(open) => !open && setPickerFor(undefined)}
        mode={pickerFor?.mode ?? 'dir'}
        fileExtensions={['.zip']}
        title={
          pickerFor?.mode === 'file' ? t('envTransfer.pickArchive') : t('envTransfer.pickFolder')
        }
        hint={
          pickerFor?.mode === 'file'
            ? t('envTransfer.pickArchiveHint')
            : t('envTransfer.pickFolderHint')
        }
        onPick={onPick}
      />
    </Card>
  );
}
