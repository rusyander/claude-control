import { useEffect, useRef, useState } from 'react';
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
  const { data: status, isError, refetch } = useRemoteAccess();
  const update = useUpdateRemoteAccess();
  const rotate = useRotateRemoteToken();
  const forget = useForgetRemoteDevice();
  const test = useTestRemoteNotification();

  const [qr, setQr] = useState('');
  const [shown, setShown] = useState(false);
  // Адрес набирают руками, а не переключают: PATCH на каждый символ отправлял
  // «https», «https:», «https:/»… — десяток записей в state.json за одно слово
  // и подставленный сервером промежуточный адрес в QR. Черновик живёт в поле,
  // на диск уходит по Enter или когда поле теряет фокус.
  const [urlDraft, setUrlDraft] = useState<string | undefined>(undefined);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Синхронный замок на смену токена: два клика подряд приходят до того, как
  // React перерисует кнопку заблокированной, и `isPending` их не разделяет.
  const rotating = useRef(false);

  const address = status?.publicUrl || status?.detectedUrl || '';

  useEffect(() => () => clearTimeout(urlTimer.current), []);

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

  // Сервер не ответил — говорим об этом, а не прячем карточку целиком: раньше
  // при ошибке она исчезала, и удалённый доступ казался просто отсутствующим.
  if (isError) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('remote.title')}
          </Typography>
          <Typography variant="body-sm" color="danger">
            {t('remote.loadError')}
          </Typography>
          <div>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {t('settings.retry')}
            </Button>
          </div>
        </Stack>
      </Card>
    );
  }

  // Пока состояние грузится, карточка стоит на месте с заголовком: исчезающая и
  // появляющаяся карточка читалась как «удалённого доступа тут нет».
  if (!status) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('remote.title')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('common.loading')}
          </Typography>
        </Stack>
      </Card>
    );
  }

  const onRotate = (): void => {
    if (rotating.current) return;
    rotating.current = true;
    rotate.mutate(undefined, {
      onSuccess: () => toast.success(t('remote.tokenRotated')),
      onError: (error) => toast.error(toErrorMessage(error)),
      onSettled: () => {
        rotating.current = false;
      },
    });
  };

  // Адрес уходит на диск сам через паузу после последнего символа, а по Enter
  // или уходу из поля — сразу: кнопки «сохранить» у текстовых полей этой
  // карточки нет, и ждать её никто не станет.
  const saveUrl = (raw: string): void => {
    clearTimeout(urlTimer.current);
    const next = raw.trim();
    if (next !== status.publicUrl) update.mutate({ publicUrl: next });
  };
  const commitUrl = (): void => {
    if (urlDraft === undefined) return;
    setUrlDraft(undefined);
    saveUrl(urlDraft);
  };
  const onUrlChange = (raw: string): void => {
    setUrlDraft(raw);
    clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => saveUrl(raw), 700);
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

        <Typography variant="body-sm" color="subtle" className="prose">
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
            value={urlDraft ?? status.publicUrl}
            placeholder={status.detectedUrl || 'https://…'}
            aria-label={t('remote.address')}
            spellCheck={false}
            onChange={(event) => onUrlChange(event.target.value)}
            onBlur={commitUrl}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitUrl();
              }
            }}
          />
          <Typography variant="caption" color="subtle">
            {t('remote.addressHint')}
          </Typography>
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
            {/* Второй клик во время смены токена выпускал второй токен: первый,
                уже показанный на QR, становился недействительным до того, как
                телефон его считал. */}
            <Button
              variant="secondary"
              size="sm"
              isLoading={rotate.isPending}
              disabled={rotate.isPending}
              onClick={onRotate}
            >
              {t('remote.rotate')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isLoading={test.isPending}
              disabled={test.isPending || status.devices.length === 0}
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
                  disabled={forget.isPending}
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
