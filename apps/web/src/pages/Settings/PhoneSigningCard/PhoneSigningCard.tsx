import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { formatDateTime } from '@shared/lib/formatDateTime';
import {
  usePhoneSigning,
  useRevokePhoneKey,
  type PhoneSigningDevice,
} from '@entities/PhoneSigning';
import styles from './PhoneSigningCard.module.scss';

/**
 * «Подпись решений телефоном»: включён ли режим, какие телефоны привязаны и их
 * отпечатки — чтобы сверить с телефоном. Включают и выключают режим на
 * телефоне; окно отзывает ключи (это только ужесточает) и, если режим остался
 * без телефонов, называет файл, удаление которого его выключает.
 */
export function PhoneSigningCard() {
  const { t, i18n } = useTranslation();
  const { data: view, isError, refetch } = usePhoneSigning();
  const revoke = useRevokePhoneKey();
  const [pending, setPending] = useState<PhoneSigningDevice | undefined>(undefined);

  if (isError || !view) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('phoneSigning.title')}
          </Typography>
          {isError ? (
            <>
              <Typography variant="body-sm" color="danger">
                {t('phoneSigning.loadError')}
              </Typography>
              <div>
                <Button variant="secondary" size="sm" onClick={() => void refetch()}>
                  {t('settings.retry')}
                </Button>
              </div>
            </>
          ) : (
            <Typography variant="body-sm" color="subtle">
              {t('common.loading')}
            </Typography>
          )}
        </Stack>
      </Card>
    );
  }

  const active = view.devices.filter((device) => !device.revokedAt);
  const time = (iso: string) => formatDateTime(iso, i18n.language);
  const labelOf = (device: PhoneSigningDevice) => device.label || t('phoneSigning.unnamed');
  const lastActive = view.enabled && active.length === 1 && pending?.id === active[0]?.id;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="body" weight="medium">
            {t('phoneSigning.title')}
          </Typography>
          {view.enabled ? (
            <Badge tone="success">{t('phoneSigning.on')}</Badge>
          ) : (
            <Badge tone="neutral">{t('phoneSigning.off')}</Badge>
          )}
          {view.enabled && view.enabledAt ? (
            <Typography variant="caption" color="subtle">
              {t('phoneSigning.enabledAt', { time: time(view.enabledAt) })}
            </Typography>
          ) : null}
        </Stack>

        <Typography variant="body-sm" color="subtle" className="prose">
          {t('phoneSigning.explain')}
        </Typography>
        <Typography variant="body-sm" color="subtle" className="prose">
          {t('phoneSigning.phoneOnly')}
        </Typography>
        {view.enabled ? (
          <Typography variant="body-sm" className="prose">
            {t('phoneSigning.whileOn')}
          </Typography>
        ) : null}

        {/* Режим без телефонов не выключить подписью — только удалением файла.
            Путь стоит здесь целиком: искать его по справке в такой момент — лишнее. */}
        {view.enabled && active.length === 0 ? (
          <Stack gap="var(--spacing-2xs)" className={styles.recovery} role="alert">
            <Typography variant="body-sm" color="danger">
              {t('phoneSigning.noDeviceOn')}
            </Typography>
            <code className={styles.path}>{view.storePath}</code>
          </Stack>
        ) : null}

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('phoneSigning.devices')}
          </Typography>
          {view.devices.length === 0 ? (
            <Typography variant="body-sm" color="subtle">
              {t('phoneSigning.noDevices')}
            </Typography>
          ) : (
            <>
              <Typography variant="caption" color="subtle">
                {t('phoneSigning.fingerprintHint')}
              </Typography>
              <ul className={styles.list}>
                {view.devices.map((device) => (
                  <li key={device.id} className={styles.device}>
                    <Stack gap="var(--spacing-3xs)" className={styles.deviceText}>
                      <Typography
                        variant="body-sm"
                        color={device.revokedAt ? 'subtle' : undefined}
                        className={device.revokedAt ? styles.revoked : undefined}
                      >
                        {labelOf(device)}
                      </Typography>
                      <code className={styles.fingerprint}>
                        {t('phoneSigning.fingerprint', { value: device.fingerprint })}
                      </code>
                      <Typography variant="caption" color="subtle">
                        {[
                          t('phoneSigning.boundAt', { time: time(device.boundAt) }),
                          device.lastUsedAt
                            ? t('phoneSigning.lastUsedAt', { time: time(device.lastUsedAt) })
                            : '',
                          device.revokedAt
                            ? t('phoneSigning.revokedAt', { time: time(device.revokedAt) })
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Typography>
                    </Stack>
                    {device.revokedAt ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        isLoading={revoke.isPending && pending?.id === device.id}
                        disabled={revoke.isPending}
                        onClick={() => setPending(device)}
                      >
                        {t('phoneSigning.revoke')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Stack>
      </Stack>

      <ConfirmDialog
        isOpen={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(undefined)}
        title={t('phoneSigning.revokeTitle')}
        description={
          lastActive
            ? t('phoneSigning.revokeLastText', { path: view.storePath })
            : t('phoneSigning.revokeText', { label: pending ? labelOf(pending) : '' })
        }
        confirmLabel={t('phoneSigning.revoke')}
        isPending={revoke.isPending}
        onConfirm={() => {
          if (pending) {
            revoke.mutate(pending.id, {
              onSuccess: () => toast.success(t('phoneSigning.revoked')),
            });
          }
          setPending(undefined);
        }}
      />
    </Card>
  );
}
