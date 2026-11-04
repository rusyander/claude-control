import { useTranslation } from 'react-i18next';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { useCoreAutostart, useCoreSupervisor } from '../api/coreSupervisorApi';

/**
 * Автозапуск ядра при входе в систему (P57): ядро встаёт и без открытой панели. Надзора нет или
 * ОС его не умеет (`unsupported`) — переключателя нет: обещать то, что не сработает, нельзя.
 * `status` не передан — переключатель читает надзор сам (шапка раздела «Задачи ядра»).
 */
export function CoreAutostartToggle({ status }: { status?: CoreSupervisorStatus }) {
  const { t } = useTranslation();
  const own = useCoreSupervisor(false);
  const autostart = useCoreAutostart();
  const current = status ?? own.data;
  if (!current || current.autostart === 'unsupported') return null;
  const label = t('coreTimeline.fault.autostart');
  return (
    <Stack gap="var(--spacing-3xs)" data-core-autostart={current.autostart}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Toggle
          size="sm"
          checked={current.autostart === 'on'}
          disabled={autostart.isPending}
          onCheckedChange={(on) => autostart.mutate(on)}
          aria-label={label}
        />
        <Typography variant="body-sm">{label}</Typography>
      </Stack>
      {(autostart.isError || autostart.data?.ok === false) && (
        <Typography variant="body-sm" color="danger" role="alert">
          {t('coreTimeline.fault.autostartFailed')}
        </Typography>
      )}
    </Stack>
  );
}
