import { useTranslation } from 'react-i18next';
import { MIN_OLLAMA_VERSION } from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import {
  JobProgress,
  jobFor,
  runningJob,
  toGb,
  useCancelLocalJob,
  useInstallRuntime,
  useStartLocalServer,
  useStopLocalServer,
} from '@entities/LocalModels';
import { DeviceChoice } from '../DeviceChoice/DeviceChoice';
import type { RuntimeCardProps } from './RuntimeCard.types';

/**
 * Сервер моделей: чей он (системный или своя копия), где лежит, какой версии,
 * работает ли и что держит в памяти. Кнопка «Скачать» — только когда своего
 * сервера нет вовсе или системный устарел: найденный в системе Ollama
 * используется как есть, и второй гигабайт ради него не качается.
 */
export function RuntimeCard({ info }: RuntimeCardProps) {
  const { t } = useTranslation();
  const install = useInstallRuntime();
  const start = useStartLocalServer();
  const stop = useStopLocalServer();
  const cancel = useCancelLocalJob();
  const { runtime, server } = info;
  const job = jobFor(info, 'runtime', 'ollama');
  const busy = Boolean(runningJob(info, 'runtime', 'ollama'));
  const canDownload = runtime.source === 'none' || runtime.outdated;
  const sizeGb = runtime.latest ? toGb(runtime.latest.sizeBytes) : 0;

  return (
    <Card padding="md" role="region" aria-label={t('localModels.runtime.title')}>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Typography variant="heading-sm" as="h2">
              {t('localModels.runtime.title')}
            </Typography>
            <Badge tone={server.running ? 'success' : 'neutral'} withDot>
              {server.running
                ? t('localModels.runtime.running', { port: server.port })
                : t('localModels.runtime.stopped')}
            </Badge>
          </Stack>
          {runtime.source === 'none' ? null : (
            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              {server.running ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="stop" />}
                  isLoading={stop.isPending}
                  onClick={() =>
                    stop.mutate(undefined, {
                      onSuccess: () => toast.success(t('localModels.runtime.stopped_toast')),
                    })
                  }
                >
                  {t('localModels.runtime.stop')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="play" />}
                  isLoading={start.isPending}
                  onClick={() => start.mutate(undefined)}
                >
                  {t('localModels.runtime.start')}
                </Button>
              )}
            </Stack>
          )}
        </Stack>
        <Typography variant="body-sm" color="muted">
          {t('localModels.runtime.what')}
        </Typography>

        {runtime.source === 'none' ? (
          <Typography variant="body-sm">{t('localModels.runtime.none')}</Typography>
        ) : (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm">
              {t(
                runtime.source === 'system'
                  ? 'localModels.runtime.system'
                  : 'localModels.runtime.panel',
              )}
            </Typography>
            <Typography variant="mono" color="muted">
              {runtime.binary}
            </Typography>
            <Typography variant="caption" color="muted">
              {runtime.version
                ? t('localModels.runtime.version', { version: runtime.version })
                : t('localModels.runtime.versionUnknown')}
            </Typography>
          </Stack>
        )}
        {runtime.outdated ? (
          <Typography variant="body-sm" color="warning">
            {t('localModels.runtime.outdated', {
              version: runtime.version,
              min: MIN_OLLAMA_VERSION,
            })}
          </Typography>
        ) : null}
        {canDownload && !busy ? (
          <div>
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" />}
              isLoading={install.isPending}
              onClick={() => install.mutate()}
            >
              {runtime.source === 'none' && sizeGb > 0
                ? t('localModels.runtime.downloadSize', { size: sizeGb })
                : t(
                    runtime.outdated
                      ? 'localModels.runtime.ownCopy'
                      : 'localModels.runtime.download',
                  )}
            </Button>
          </div>
        ) : null}
        {job ? (
          <JobProgress
            job={job}
            {...(job.state === 'running' ? { onCancel: () => cancel.mutate(job.id) } : {})}
          />
        ) : null}

        {server.running ? (
          <Stack gap="var(--spacing-2xs)">
            {server.context > 0 ? (
              <Typography variant="caption" color="muted">
                {t('localModels.runtime.context', { value: server.context })}
              </Typography>
            ) : null}
            {server.kvCache === 'q4_0' ? (
              <Typography variant="caption" color="muted">
                {t('localModels.runtime.contextQ4')}
              </Typography>
            ) : null}
            {server.loaded.length === 0 ? (
              <Typography variant="caption" color="muted">
                {t('localModels.runtime.nothingLoaded')}
              </Typography>
            ) : null}
          </Stack>
        ) : null}
        <DeviceChoice info={info} />
        <Typography variant="caption" color="muted">
          {[
            t('localModels.runtime.folder', { path: info.root }),
            t('localModels.runtime.used', { value: toGb(info.diskUsedBytes) }),
          ].join(' · ')}
        </Typography>
      </Stack>
    </Card>
  );
}
