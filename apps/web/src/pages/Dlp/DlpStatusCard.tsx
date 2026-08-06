import { useTranslation } from 'react-i18next';
import type { DlpSettings, DlpStatus, EndpointProfile } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';

interface Props {
  settings: DlpSettings;
  status: DlpStatus;
  profiles: EndpointProfile[];
  canStart: boolean;
  isBusy: boolean;
  onChange: (patch: Partial<DlpSettings>) => void;
  onToggleRunning: (running: boolean) => void;
}

/**
 * Состояние прокси и его настройки: адрес для CLI, куда пересылать, что делать
 * с неразобранным.
 *
 * Адрес, который вписывают в CLI, показан крупно и первым: это единственное,
 * что нужно сделать снаружи панели, и пока он не прописан, прокси не видит
 * ничего — а раздел при этом выглядит работающим.
 */
export function DlpStatusCard({
  settings,
  status,
  profiles,
  canStart,
  isBusy,
  onChange,
  onToggleRunning,
}: Props) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('dlp.statusTitle')}
            </Typography>
            <Badge tone={status.running ? 'success' : 'neutral'} withDot>
              {status.running ? t('dlp.running') : t('dlp.stopped')}
            </Badge>
          </Stack>
          <Button
            variant={status.running ? 'secondary' : 'primary'}
            size="sm"
            leftIcon={<Icon name={status.running ? 'stop' : 'check'} size={16} />}
            onClick={() => onToggleRunning(!status.running)}
            disabled={!status.running && !canStart}
            isLoading={isBusy}
          >
            {status.running ? t('dlp.stop') : t('dlp.start')}
          </Button>
        </Stack>

        {status.running && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" color="subtle">
              {t('dlp.addressHint')}
            </Typography>
            <Typography variant="mono">{status.address}</Typography>
            <Typography variant="caption" color="subtle">
              {t('dlp.counters', {
                requests: status.requests,
                masked: status.masked,
                blocked: status.blocked,
              })}
            </Typography>
          </Stack>
        )}

        {status.error && (
          <Typography variant="body-sm" color="danger">
            {status.error}
          </Typography>
        )}

        <TextField
          label={t('dlp.port')}
          value={String(settings.port)}
          onChange={(value) => onChange({ port: Number(value) || settings.port })}
          hint={t('dlp.portHint')}
          isMono
        />

        <TextField
          label={t('dlp.upstreamUrl')}
          value={settings.upstreamUrl}
          onChange={(upstreamUrl) => onChange({ upstreamUrl })}
          placeholder="https://api.anthropic.com"
          hint={t('dlp.upstreamHint')}
          isMono
        />

        {profiles.length > 0 && (
          <SelectField
            label={t('dlp.upstreamProfile')}
            value={settings.upstreamProfileId}
            onChange={(upstreamProfileId) => onChange({ upstreamProfileId })}
            options={[
              { value: '', label: t('dlp.upstreamProfileNone') },
              ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
            ]}
            hint={t('dlp.upstreamProfileHint')}
          />
        )}

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm">{t('dlp.passUnknown')}</Typography>
            <Typography variant="caption" color="subtle">
              {t('dlp.passUnknownHint')}
            </Typography>
          </Stack>
          <Toggle
            checked={settings.passUnknown}
            onCheckedChange={(passUnknown) => onChange({ passUnknown })}
            aria-label={t('dlp.passUnknown')}
          />
        </Stack>

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm">{t('dlp.journal')}</Typography>
            <Typography variant="caption" color="subtle">
              {t('dlp.journalHint')}
            </Typography>
          </Stack>
          <Toggle
            checked={settings.journal}
            onCheckedChange={(journal) => onChange({ journal })}
            aria-label={t('dlp.journal')}
          />
        </Stack>
      </Stack>
    </Card>
  );
}
