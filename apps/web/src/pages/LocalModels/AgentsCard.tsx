import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import {
  JobProgress,
  jobFor,
  runningJob,
  useCancelLocalJob,
  useDisconnectLocal,
  useInstallQwenCode,
} from '@entities/LocalModels';
import { ClaudeSwitch } from './ClaudeSwitch';

interface AgentsCardProps {
  info: LocalModelsInfo;
}

/** Кто работает на локальной модели и с чьим набором правил. */
export function AgentsCard({ info }: AgentsCardProps) {
  const { t } = useTranslation();
  const disconnect = useDisconnectLocal();
  const installQwen = useInstallQwenCode();
  const navigate = useNavigate();
  const cancel = useCancelLocalJob();
  const { connect, qwenCode, kit } = info;
  const qwenJob = jobFor(info, 'qwen-code', 'qwen-code');
  const qwenBusy = Boolean(runningJob(info, 'qwen-code', 'qwen-code'));

  return (
    <Card padding="md" role="region" aria-label={t('localModels.connect.title')}>
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-xs)">
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Typography variant="heading-sm" as="h2">
                {t('localModels.connect.title')}
              </Typography>
              <Badge tone={connect.active ? 'success' : 'neutral'} withDot>
                {connect.active ? connect.model : '—'}
              </Badge>
            </Stack>
            {connect.active ? (
              <Button
                size="sm"
                variant="secondary"
                isLoading={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(undefined, {
                    onSuccess: () => toast.success(t('localModels.connect.disconnected')),
                  })
                }
              >
                {t('localModels.connect.disconnect')}
              </Button>
            ) : null}
          </Stack>
          <Typography variant="body-sm" color="muted">
            {t('localModels.connect.what')}
          </Typography>
          <Typography variant="body-sm">
            {connect.active
              ? t('localModels.connect.active', { model: connect.model })
              : t('localModels.connect.inactive')}
          </Typography>
          {connect.otherActive ? (
            <Typography variant="body-sm" color="warning">
              {t('localModels.connect.otherActive', { title: connect.otherActive })}
            </Typography>
          ) : null}
        </Stack>

        <ClaudeSwitch info={info} />

        <Stack gap="var(--spacing-xs)">
          <Typography variant="heading-sm" as="h3">
            {t('localModels.qwen.title')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('localModels.qwen.what')}
          </Typography>
          {qwenCode.source === 'none' ? (
            <Typography variant="body-sm">{t('localModels.qwen.none')}</Typography>
          ) : (
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm">
                {qwenCode.source === 'panel'
                  ? t('localModels.qwen.panel', { version: qwenCode.version || '—' })
                  : t('localModels.qwen.system')}
              </Typography>
              <Typography variant="mono" color="muted">
                {qwenCode.binary}
              </Typography>
            </Stack>
          )}
          {qwenCode.source === 'none' && !qwenBusy ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                isLoading={installQwen.isPending}
                onClick={() => installQwen.mutate()}
              >
                {t('localModels.qwen.install')}
              </Button>
            </div>
          ) : null}
          {qwenJob ? (
            <JobProgress
              job={qwenJob}
              {...(qwenJob.state === 'running'
                ? { onCancel: () => cancel.mutate(qwenJob.id) }
                : {})}
            />
          ) : null}
        </Stack>

        {/* Набор панели переехал на свою страницу (В2): режим там действует на
            любой прогон, а не только на локальную модель. Здесь — где он и что выбрано. */}
        <Stack gap="var(--spacing-xs)">
          <Typography variant="heading-sm" as="h3">
            {t('localModels.kit.title')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('localModels.kit.moved', {
              claude: t(`kit.modes.mode.${kit.claude}`),
              qwen: t(`kit.modes.mode.${kit.qwen}`),
            })}
          </Typography>
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void navigate({ to: '/kit' } as never)}
            >
              {t('localModels.kit.open')}
            </Button>
          </div>
        </Stack>
      </Stack>
    </Card>
  );
}
