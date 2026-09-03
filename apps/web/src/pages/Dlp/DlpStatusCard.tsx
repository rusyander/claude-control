import { useState, type FormEvent } from 'react';
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

const PORT_MIN = 1024;
const PORT_MAX = 65535;

function parsePort(raw: string): number | undefined {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX ? value : undefined;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Состояние прокси и его настройки: адрес для CLI, куда пересылать, что делать
 * с неразобранным.
 *
 * Адрес, который вписывают в CLI, показан крупно и первым: это единственное,
 * что нужно сделать снаружи панели, и пока он не прописан, прокси не видит
 * ничего — а раздел при этом выглядит работающим.
 *
 * Порт и адрес наверх набирают руками, а не переключают, поэтому они живут
 * черновиком и уходят на сервер по Enter или когда поле теряет фокус. PATCH на
 * каждый символ отправлял «5», «52», «526» (все ниже 1024 — отказ), а
 * управляемое поле после каждого ответа сервера теряло набранное. Автосохранения
 * по паузе здесь нет намеренно: половина адреса или порта при работающем прокси
 * означала бы перезапуск в никуда.
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
  const [portDraft, setPortDraft] = useState<string | undefined>(undefined);
  const [portError, setPortError] = useState<string | undefined>(undefined);
  const [urlDraft, setUrlDraft] = useState<string | undefined>(undefined);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);

  const commitPort = (): void => {
    if (portDraft === undefined) return;
    const value = parsePort(portDraft);
    if (value === undefined) {
      setPortError(t('dlp.portInvalid'));
      return;
    }
    setPortError(undefined);
    setPortDraft(undefined);
    if (value !== settings.port) onChange({ port: value });
  };

  const commitUrl = (): void => {
    if (urlDraft === undefined) return;
    const next = urlDraft.trim();
    if (next && !isHttpUrl(next)) {
      setUrlError(t('dlp.upstreamInvalid'));
      return;
    }
    setUrlError(undefined);
    setUrlDraft(undefined);
    if (next !== settings.upstreamUrl) onChange({ upstreamUrl: next });
  };

  const submit = (commit: () => void) => (event: FormEvent) => {
    event.preventDefault();
    commit();
  };

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

        {/* Форма ради Enter: у текстового поля нет своего обработчика клавиш, а
            отправка формы — стандартный способ сказать «готово». onBlur всплывает
            от поля к форме, поэтому уход из поля тоже сохраняет. */}
        <form onSubmit={submit(commitPort)} onBlur={commitPort} noValidate>
          <TextField
            label={t('dlp.port')}
            value={portDraft ?? String(settings.port)}
            onChange={(value) => {
              setPortDraft(value);
              setPortError(undefined);
            }}
            hint={t('dlp.portHint')}
            error={portError}
            isMono
          />
        </form>

        <form onSubmit={submit(commitUrl)} onBlur={commitUrl} noValidate>
          <TextField
            label={t('dlp.upstreamUrl')}
            value={urlDraft ?? settings.upstreamUrl}
            onChange={(value) => {
              setUrlDraft(value);
              setUrlError(undefined);
            }}
            placeholder="https://api.anthropic.com"
            hint={t('dlp.upstreamHint')}
            error={urlError}
            isMono
          />
        </form>

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

        {status.running && (
          <Typography variant="caption" color="subtle">
            {t('dlp.restartOnChange')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
