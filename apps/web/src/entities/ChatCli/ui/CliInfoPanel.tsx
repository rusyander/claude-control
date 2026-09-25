import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { useChatCli, useUpdateChatCli } from '../api/ChatCliApi';
import type { CliInfoPanelProps } from './CliInfoPanel.types';

/**
 * Какой CLI запускает панель и нет ли рядом новее. Без этой строки старая
 * копия первой в PATH работала молча, пока модель не отказалась от неё сырой
 * ошибкой API (живой прогон 25.09.2026).
 */
export function CliInfoPanel({ refresh, withUpdate }: CliInfoPanelProps) {
  const { t } = useTranslation();
  const cli = useChatCli({ refresh: refresh === true });
  const update = useUpdateChatCli();
  const info = cli.data;

  if (cli.isLoading) {
    return (
      <Typography variant="caption" color="subtle">
        {t('chat.cli.loading')}
      </Typography>
    );
  }
  if (!info) return null;

  const runUpdate = () => {
    update.mutate(undefined, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success(t('chat.cli.updated', { version: result.info.version ?? '?' }));
        } else {
          toast.error(t('chat.cli.updateFailed', { output: result.output || '—' }));
        }
      },
      onError: () => toast.error(t('chat.cli.updateFailed', { output: '—' })),
    });
  };

  return (
    <Stack gap="var(--spacing-3xs)" data-cli-info>
      <Typography variant="caption" color="subtle">
        {info.path
          ? t('chat.cli.current', { version: info.version ?? '?', path: info.path })
          : t('chat.cli.missing', { command: info.command })}
      </Typography>
      {info.newer && (
        <Typography variant="caption" color="warning" data-cli-newer>
          {t('chat.cli.newer', { version: info.newer.version ?? '?', path: info.newer.path })}
        </Typography>
      )}
      {withUpdate && info.path && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="refresh" size={18} />}
            onClick={runUpdate}
            isLoading={update.isPending}
            data-cli-update
          >
            {t('chat.cli.update')}
          </Button>
        </div>
      )}
    </Stack>
  );
}
