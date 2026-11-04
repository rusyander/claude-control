import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CoreProxyCode, CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { queryKeys } from '@shared/api/query-keys';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon, type IconName } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreSupervisor, useRestartCore } from '../api/coreSupervisorApi';
import { CODE_OF_VIEW, coreFaultView, secondsUntil, type CoreFaultView } from '../model/faultView';
import { CoreAutostartToggle } from './CoreAutostartToggle';
import styles from './CoreFaultCard.module.scss';

const ICON_OF_VIEW: Record<CoreFaultView, IconName> = {
  fault: 'error',
  starting: 'refresh',
  absent: 'warning',
  unverified: 'warning',
  unreachable: 'warning',
};

/**
 * Карточка отказа прокладки ядра (этап 10): приложение поднимает ядро само, поэтому «ядро не
 * запущено» — это состояние надзора, а не просьба набрать команду. Поднимается — страница ждёт
 * опросом и перечитывает ядро, как только оно ответило; надзор сдался — выход, хвост журнала
 * (секреты скрыты сервером) и «Перезапустить». Один вид для списка, ленты и сценариев.
 */
export function CoreFaultCard({ refusal }: { refusal: CoreProxyCode }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const supervisor = useCoreSupervisor(true);
  const status = supervisor.data;
  const view = coreFaultView(refusal, status);
  const code = CODE_OF_VIEW[view];
  const up = status?.state === 'up';

  // Ядро поднялось — отказ на экране устарел: перечитать всё ядро (его корень ключей общий).
  useEffect(() => {
    if (up) void client.invalidateQueries({ queryKey: queryKeys.core.all });
  }, [up, client]);

  return (
    <div data-core-refusal={code} data-core-fault-view={view}>
      <EmptyState
        icon={ICON_OF_VIEW[view]}
        title={t(`coreTimeline.refusal.${code}.title`)}
        text={t(`coreTimeline.refusal.${code}.text`)}
      />
      {status && view === 'starting' && <StartingDetails status={status} />}
      {status && view === 'fault' && <FaultDetails status={status} />}
    </div>
  );
}

function StartingDetails({ status }: { status: CoreSupervisorStatus }) {
  const { t } = useTranslation();
  const seconds = secondsUntil(status.nextRetryAt, Date.now());
  if (status.state !== 'restarting' || seconds === null) return null;
  return (
    <Typography variant="body-sm" color="subtle" align="center" data-core-fault-retry>
      {t('coreTimeline.fault.restarting', { seconds })}
    </Typography>
  );
}

function FaultDetails({ status }: { status: CoreSupervisorStatus }) {
  const { t } = useTranslation();
  const restart = useRestartCore();
  const exit = status.lastExit;
  return (
    <Stack gap="var(--spacing-sm)" className={styles.details} data-core-fault-details>
      <Stack direction="row" gap="var(--spacing-md)" wrap>
        <Typography variant="body-sm" color="subtle">
          {t('coreTimeline.fault.restarts', { count: status.restarts })}
        </Typography>
        {/* Код выхода: POSIX — от ОС (ядро — ребёнок панели), Windows — из `core.exit.json`, что
            ядро пишет само. Снятое принудительно ядро итога не оставит — строки нет, причина в журнале. */}
        {exit?.code != null && (
          <Typography variant="body-sm" color="subtle" data-core-fault-exit>
            {t('coreTimeline.fault.exitCode', { code: exit.code })}
          </Typography>
        )}
        {exit?.code == null && exit?.signal != null && (
          <Typography variant="body-sm" color="subtle" data-core-fault-exit>
            {t('coreTimeline.fault.exitSignal', { signal: exit.signal })}
          </Typography>
        )}
      </Stack>
      <Typography variant="caption" color="subtle">
        {t('coreTimeline.fault.logTitle')}
      </Typography>
      {status.logTail.length > 0 ? (
        <pre className={styles.log} data-core-fault-log tabIndex={0}>
          {status.logTail.join('\n')}
        </pre>
      ) : (
        <Typography variant="body-sm" color="subtle">
          {t('coreTimeline.fault.logEmpty')}
        </Typography>
      )}
      <Stack direction="row" gap="var(--spacing-md)" align="center" wrap>
        <Button
          leftIcon={<Icon name="refresh" size={24} />}
          onClick={() => restart.mutate()}
          isLoading={restart.isPending}
          data-core-fault-restart
        >
          {t('coreTimeline.fault.restart')}
        </Button>
        <CoreAutostartToggle status={status} />
      </Stack>
      {restart.isError && (
        <Typography variant="body-sm" color="danger" role="alert">
          {t('coreTimeline.fault.restartFailed')}
        </Typography>
      )}
    </Stack>
  );
}
