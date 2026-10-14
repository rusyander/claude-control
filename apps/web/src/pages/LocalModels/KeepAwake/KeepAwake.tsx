import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { useSetKeepAwake } from '@entities/LocalModels';
import type { KeepAwakeProps } from './KeepAwake.types';

/**
 * «Не давать системе уснуть во время прогона» (L4b). Ночная задача на локальной модели —
 * часы без человека; сон компьютера по таймеру простоя обрывает её молча. Включено по
 * умолчанию: запрет ставится, пока идёт прогон, и снимается, когда прогонов нет.
 * Перезапуска сервера не требует.
 */
export function KeepAwake({ info }: KeepAwakeProps) {
  const { t } = useTranslation();
  const set = useSetKeepAwake();
  const { server } = info;

  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Toggle
          checked={server.keepAwake}
          disabled={set.isPending}
          aria-label={t('localModels.keepAwake.toggle')}
          onCheckedChange={(keepAwake) => set.mutate(keepAwake)}
        />
        <Typography variant="body-sm">{t('localModels.keepAwake.toggle')}</Typography>
      </Stack>
      <Typography variant="caption" color="muted">
        {t(server.keepAwake ? 'localModels.keepAwake.on' : 'localModels.keepAwake.off')}
      </Typography>
      {server.awake ? (
        <Typography variant="caption" color="muted" role="status" aria-live="polite">
          {t('localModels.keepAwake.holding')}
        </Typography>
      ) : null}
    </Stack>
  );
}
