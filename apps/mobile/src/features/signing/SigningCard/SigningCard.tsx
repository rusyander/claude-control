import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Constants from 'expo-constants';
import type { PhoneSigningView } from '@agentdeck/contracts/phone-signing';
import { Button, Card, Mono, Muted, Row, Title } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT, type Dictionary } from '../../../shared/config/i18n';
import { activePanel, useConnection } from '../../../shared/api/connection';
import { signingSupported } from '../../../shared/api/signing/keyStore';
import { refreshIdentity } from '../../../shared/lib/panel-switch';
import {
  useBindPhone,
  useMyKey,
  useSigning,
  useSigningMode,
  useUnbindPhone,
} from '../../../entities/signing/api';
import { keyStanding, type KeyStanding } from '../../../entities/signing/keyStanding';
import { styles } from './SigningCard.styles';

/**
 * Подпись решений ключом этого телефона: привязать, включить режим, выключить,
 * отвязать. Включение раскрывает подтверждение со списком отпечатков — их
 * сверяют с окном панели, и включается ровно показанный набор. Окно панели само
 * режим не включает: только отзывает ключи.
 */

type Texts = Dictionary['signing'];

export function SigningCard() {
  const t = useT().signing;
  const connection = useConnection();
  const active = activePanel(connection);
  const signing = useSigning();
  const view = signing.data;
  const mine = useMyKey(view?.machineId);
  const bind = useBindPhone();
  const mode = useSigningMode();
  const unbind = useUnbindPhone();
  const [confirm, setConfirm] = useState<'enable' | 'unbind' | undefined>(undefined);

  // Подпись каждого решения берёт номер машины из записи телефона; запись
  // старой пары его ещё не знает — спросить машину.
  const stale = Boolean(view && active && active.machineId !== view.machineId);
  useEffect(() => {
    if (stale) void refreshIdentity();
  }, [stale]);

  if (!active || !view) return null;

  const key = mine.data ?? undefined;
  const standing = keyStanding(view, key);
  const busy = bind.isPending || mode.isPending || unbind.isPending;
  const failure = bind.error ?? mode.error ?? unbind.error;
  const label = Constants.deviceName?.trim() || t.unnamed;
  const closed = standing === 'bound' && !view.enabled;

  return (
    <Card>
      <Title>{t.title}</Title>
      <Muted>{t.about}</Muted>
      <Text style={styles.state}>{view.enabled ? t.modeOn : t.modeOff}</Text>
      <Devices t={t} view={view} mine={key?.publicKey} />

      {signingSupported() ? null : <Muted>{t.unsupported}</Muted>}
      {key && standing === 'bound' ? <Muted>{t.mine(key.fingerprint)}</Muted> : null}

      {signingSupported() && standing !== 'bound' ? (
        <BindBlock
          t={t}
          enabled={view.enabled}
          standing={standing}
          busy={busy}
          onBind={() => bind.mutate({ view, label })}
        />
      ) : null}

      {standing === 'bound' && view.enabled ? (
        <>
          <Button
            title={t.disable}
            onPress={() => mode.mutate({ view, enabled: false })}
            disabled={busy}
          />
          <Muted>{t.unbindBlocked}</Muted>
        </>
      ) : null}

      {closed && confirm === undefined ? (
        <Row gap={space.sm}>
          <Button
            title={t.enable}
            tone="accent"
            onPress={() => setConfirm('enable')}
            disabled={busy}
            style={styles.grow}
          />
          <Button
            title={t.unbind}
            tone="ghost"
            onPress={() => setConfirm('unbind')}
            disabled={busy}
            style={styles.grow}
          />
        </Row>
      ) : null}

      {closed && confirm === 'enable' ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>{t.enableTitle}</Text>
          <Muted>{t.enableList}</Muted>
          {view.devices
            .filter((device) => !device.revokedAt)
            .map((device) => (
              <Mono key={device.id}>{`${device.label || t.unnamed} — ${device.fingerprint}`}</Mono>
            ))}
          <Muted>{t.enableLoss}</Muted>
          <Mono>{view.storePath}</Mono>
          <Choice
            t={t}
            yes={t.confirmEnable}
            tone="accent"
            busy={busy}
            onYes={() => mode.mutate({ view, enabled: true })}
            onClose={() => setConfirm(undefined)}
          />
        </View>
      ) : null}

      {closed && key && confirm === 'unbind' ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>{t.unbindTitle}</Text>
          <Muted>{t.unbindAbout}</Muted>
          <Choice
            t={t}
            yes={t.confirmUnbind}
            tone="danger"
            busy={busy}
            onYes={() => unbind.mutate({ view, key })}
            onClose={() => setConfirm(undefined)}
          />
        </View>
      ) : null}

      {failure ? <Mono style={styles.danger}>{failure.message}</Mono> : null}
    </Card>
  );
}

/** Список ключей панели: этот телефон помечен, отозванные зачёркнуты. */
function Devices({
  t,
  view,
  mine,
}: {
  t: Texts;
  view: PhoneSigningView;
  mine: string | undefined;
}) {
  return (
    <View style={styles.list}>
      <Muted>{t.devices}</Muted>
      {view.devices.length === 0 ? <Muted>{t.noDevices}</Muted> : null}
      {view.devices.map((device) => (
        <View key={device.id} style={styles.device}>
          <Text style={device.revokedAt ? styles.revoked : styles.name}>
            {device.label || t.unnamed}
            {device.publicKey === mine ? ` · ${t.thisPhone}` : ''}
            {device.revokedAt ? ` · ${t.revoked}` : ''}
          </Text>
          <Mono>{device.fingerprint}</Mono>
        </View>
      ))}
    </View>
  );
}

/** Привязка: при включённом режиме новый ключ не примется — сказать, как быть. */
function BindBlock({
  t,
  enabled,
  standing,
  busy,
  onBind,
}: {
  t: Texts;
  enabled: boolean;
  standing: KeyStanding;
  busy: boolean;
  onBind: () => void;
}) {
  if (enabled) return <Mono style={styles.warn}>{t.bindBlocked}</Mono>;
  return (
    <>
      {standing === 'revoked' ? <Muted>{t.revokedMine}</Muted> : null}
      <Button title={t.bind} tone="accent" onPress={onBind} disabled={busy} />
    </>
  );
}

function Choice({
  t,
  yes,
  tone,
  busy,
  onYes,
  onClose,
}: {
  t: Texts;
  yes: string;
  tone: 'accent' | 'danger';
  busy: boolean;
  onYes: () => void;
  onClose: () => void;
}) {
  return (
    <Row gap={space.sm}>
      <Button
        title={yes}
        tone={tone}
        onPress={() => {
          onClose();
          onYes();
        }}
        disabled={busy}
        style={styles.grow}
      />
      <Button title={t.cancel} tone="ghost" onPress={onClose} style={styles.grow} />
    </Row>
  );
}
