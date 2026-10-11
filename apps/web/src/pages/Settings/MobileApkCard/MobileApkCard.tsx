import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { formatBytes } from '@shared/lib/formatBytes';
import { formatDateTime } from '@shared/lib/formatDateTime';
import {
  useBuildMobileApk,
  useInstallMobileApk,
  useMobileApk,
  type MobileApkStatus,
} from '@entities/MobileApp';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';
import styles from './MobileApkCard.module.scss';

const STATE_TONE = {
  idle: 'neutral',
  building: 'info',
  succeeded: 'success',
  failed: 'danger',
} as const;

/** Подпись под кнопкой: с какого часа идёт сборка или когда она кончилась. */
function timingOf(
  status: MobileApkStatus,
  format: (key: 'buildingSince' | 'finishedAt', time: string) => string,
): string | undefined {
  if (status.state === 'building' && status.startedAt) {
    return format('buildingSince', status.startedAt);
  }
  return status.finishedAt ? format('finishedAt', status.finishedAt) : undefined;
}

/** Почему кнопок установки нет или как ими пользоваться. */
function deviceHint(status: MobileApkStatus): 'adbMissing' | 'noDevices' | 'devicesHint' {
  if (status.adbMissing) return 'adbMissing';
  return status.devices.length === 0 ? 'noDevices' : 'devicesHint';
}

/**
 * APK телефонного приложения кнопкой: тот же сборщик, что `pnpm mobile:apk`,
 * поэтому собранное здесь и из терминала не расходится. Готовый файл ставится
 * на телефон по `adb` (USB или беспроводная отладка) или скачивается.
 */
export function MobileApkCard() {
  const { t, i18n } = useTranslation();
  const { data: status } = useMobileApk();
  const build = useBuildMobileApk();
  const install = useInstallMobileApk();
  // Вывод сборки читают снизу: последние строки — то, что идёт сейчас.
  const logRef = useRef<HTMLPreElement>(null);
  const lastLine = status?.log.at(-1);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lastLine]);
  if (!status) return null;

  const building = status.state === 'building';
  const timing = timingOf(status, (key, time) =>
    t(`settings.phone.${key}`, { time: formatDateTime(time, i18n.language) }),
  );
  const startBuild = (): void =>
    build.mutate(undefined, {
      onError: (error) => toast.error(toErrorMessage(error)),
    });
  const installOn = (device: string): void =>
    install.mutate(device, {
      onSuccess: (result) =>
        result.ok
          ? toast.success(t('settings.phone.installed', { device }))
          : toast.error(result.output),
      onError: (error) => toast.error(toErrorMessage(error)),
    });

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Typography variant="body" weight="medium">
            {t('settings.phone.apkTitle')}
          </Typography>
          <Badge tone={STATE_TONE[status.state]}>{t(`settings.phone.state_${status.state}`)}</Badge>
        </Stack>
        <Typography variant="body-sm" color="subtle" className="prose">
          {t('settings.phone.apkExplain')}
        </Typography>

        {status.available ? (
          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <Button
              onClick={startBuild}
              isLoading={building || build.isPending}
              disabled={building}
            >
              {status.file ? t('settings.phone.rebuild') : t('settings.phone.build')}
            </Button>
            {timing ? (
              <Typography variant="body-sm" color="subtle">
                {timing}
              </Typography>
            ) : null}
          </Stack>
        ) : (
          <Typography variant="body-sm" color="subtle">
            {t('settings.phone.unavailable')}
          </Typography>
        )}

        {status.log.length > 0 && status.state !== 'succeeded' ? (
          <pre
            ref={logRef}
            tabIndex={0}
            className={styles.log}
            aria-label={t('settings.phone.logLabel')}
          >
            {status.log.join('\n')}
          </pre>
        ) : null}

        {status.file ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm">
              {t('settings.phone.file', {
                size: formatBytes(status.file.size),
                time: formatDateTime(status.file.builtAt, i18n.language),
              })}
            </Typography>
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              {status.devices.map((device) => (
                <Button
                  key={device}
                  variant="secondary"
                  onClick={() => installOn(device)}
                  isLoading={install.isPending && install.variables === device}
                  disabled={building || install.isPending}
                >
                  {t('settings.phone.installOn', { device })}
                </Button>
              ))}
              <a className={styles.download} href="/api/mobile/apk/file" download>
                {t('settings.phone.download')}
              </a>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t(`settings.phone.${deviceHint(status)}`)}
            </Typography>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
