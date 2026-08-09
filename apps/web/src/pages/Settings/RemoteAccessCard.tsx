import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import type { RemotePairing } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  useForgetRemoteDevice,
  useRemoteAccess,
  useRotateRemoteToken,
  useTestRemoteNotification,
  useUpdateRemoteAccess,
} from '@entities/Remote';
import { SettingToggleRow } from './SettingToggleRow';
import styles from './RemoteAccessCard.module.scss';

/**
 * Удалённый доступ: телефон в другом конце города видит тот же чат и получает
 * уведомление, когда работа закончилась или упёрлась в вопрос.
 *
 * Карточка отвечает на три вопроса подряд, и порядок здесь не случаен: включён
 * ли доступ вообще (пока выключен — до API дотягивается только своя машина),
 * каким адресом снаружи (его даёт Tailscale, панель его лишь показывает) и чем
 * представляется телефон. Токен рисуется QR-кодом, потому что набирать его
 * руками — это тридцать символов с телефона и опечатка на второй попытке.
 */
export function RemoteAccessCard() {
  const { t } = useTranslation();
  const { data: status } = useRemoteAccess();
  const update = useUpdateRemoteAccess();
  const rotate = useRotateRemoteToken();
  const forget = useForgetRemoteDevice();
  const test = useTestRemoteNotification();

  const [qr, setQr] = useState('');
  const [shown, setShown] = useState(false);

  const address = status?.publicUrl || status?.detectedUrl || '';

  // Код перерисовывается на смену токена или адреса: показанный старый увёл бы
  // телефон в панель, которой уже нет.
  useEffect(() => {
    if (!status || !shown || !address) {
      setQr('');
      return;
    }
    const pairing: RemotePairing = { url: address, token: status.token };
    void QRCode.toDataURL(JSON.stringify(pairing), { margin: 1, width: 240 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [status, shown, address]);

  if (!status) return null;

  const onRotate = (): void => {
    rotate.mutate(undefined, {
      onSuccess: () => toast.success(t('remote.tokenRotated')),
      onError: (error) => toast.error(toErrorMessage(error)),
    });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Typography variant="body" weight="medium">
            {t('remote.title')}
          </Typography>
          {status.enabled ? (
            <Badge tone="success">{t('remote.on')}</Badge>
          ) : (
            <Badge tone="neutral">{t('remote.off')}</Badge>
          )}
        </Stack>

        <Typography variant="body-sm" color="subtle">
          {t('remote.explain')}
        </Typography>

        <SettingToggleRow
          label={t('remote.enable')}
          hint={t('remote.enableHint')}
          checked={status.enabled}
          onChange={(enabled) => update.mutate({ enabled })}
        />

        {/* Адрес не настраивается вручную без нужды: его знает Tailscale, а
            панель лишь показывает найденное. Поле остаётся на случай другого
            туннеля — тогда адрес приходит извне и угадать его нечем. */}
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('remote.address')}
          </Typography>
          {status.detectedUrl ? (
            <Typography variant="body-sm" color="subtle">
              {status.detectedUrl}
              {status.serveActive ? ` · ${t('remote.serveOn')}` : ` · ${t('remote.serveOff')}`}
            </Typography>
          ) : (
            <Typography variant="body-sm" color="subtle">
              {t('remote.noTailscale')}
            </Typography>
          )}
          <input
            className={styles.input}
            value={status.publicUrl}
            placeholder={status.detectedUrl || 'https://…'}
            onChange={(event) => update.mutate({ publicUrl: event.target.value })}
          />
        </Stack>

        <Stack gap="var(--spacing-xs)">
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="link" size={18} />}
              onClick={() => setShown((value) => !value)}
              disabled={!address}
            >
              {shown ? t('remote.hidePairing') : t('remote.showPairing')}
            </Button>
            <Button variant="secondary" size="sm" isLoading={rotate.isPending} onClick={onRotate}>
              {t('remote.rotate')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isLoading={test.isPending}
              disabled={status.devices.length === 0}
              onClick={() =>
                test.mutate(undefined, {
                  onSuccess: (result) =>
                    toast.success(t('remote.testSent', { count: result.devices })),
                  onError: (error) => toast.error(toErrorMessage(error)),
                })
              }
            >
              {t('remote.test')}
            </Button>
          </Stack>
          {!address && (
            <Typography variant="body-sm" color="subtle">
              {t('remote.noAddressHint')}
            </Typography>
          )}
        </Stack>

        {shown && (
          <Stack gap="var(--spacing-xs)" className={styles.pairing}>
            {qr ? <img className={styles.qr} src={qr} alt={t('remote.qrAlt')} /> : null}
            <Typography variant="caption" color="subtle">
              {t('remote.qrHint')}
            </Typography>
            <code className={styles.token}>{status.token}</code>
            <Typography variant="caption" color="danger">
              {t('remote.tokenWarning')}
            </Typography>
          </Stack>
        )}

        <SettingToggleRow
          label={t('remote.notify')}
          hint={t('remote.notifyHint')}
          checked={status.notify}
          onChange={(notify) => update.mutate({ notify })}
        />

        {status.devices.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('remote.devices')}
            </Typography>
            {status.devices.map((device) => (
              <Stack
                key={device.token}
                direction="row"
                gap="var(--spacing-xs)"
                align="center"
                className={styles.device}
              >
                <Typography variant="body-sm">{device.label || device.platform}</Typography>
                <Typography variant="caption" color="subtle">
                  {device.registeredAt.slice(0, 16).replace('T', ' ')}
                </Typography>
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={forget.isPending}
                  onClick={() => forget.mutate(device.token)}
                >
                  {t('remote.forget')}
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
