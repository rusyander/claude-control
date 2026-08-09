import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Button, Card, Mono, Muted, Row, Screen, Title } from '../../src/shared/ui';
import { colors, font, radius, space } from '../../src/shared/config/theme';
import { setLanguage, useLanguage, useT, type Language } from '../../src/shared/config/i18n';
import { clearConnection, isConfigured, useConnection } from '../../src/shared/api/connection';
import { registerForPush } from '../../src/shared/lib/notifications';
import {
  useForgetDevice,
  useRemote,
  useRemoteUpdate,
  useTestNotification,
} from '../../src/entities/remote/api';

/**
 * Настройки: с какой панелью мы связаны и дойдут ли до телефона уведомления.
 *
 * Второе важнее первого. Путь сигнала до телефона длинный — разрешение в
 * системе, идентификатор проекта EAS, ключи FCM, живой push-токен, — и любое
 * звено может молча отсутствовать. Поэтому здесь не «включено/выключено», а
 * причина: экран обязан назвать то самое звено, которого не хватает.
 */
export default function SettingsScreen() {
  const t = useT();
  const language = useLanguage();
  const router = useRouter();
  const connection = useConnection();
  const remote = useRemote();
  const update = useRemoteUpdate();
  const forget = useForgetDevice();
  const test = useTestNotification();

  const [push, setPush] = useState('');
  const [busy, setBusy] = useState(false);

  const enablePush = async (): Promise<void> => {
    setBusy(true);
    const result = await registerForPush(t.settings.thisPhone);
    setPush(result.problem ?? t.settings.pushOn);
    setBusy(false);
    void remote.refetch();
  };

  const status = remote.data;

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={remote.isFetching}
          onRefresh={() => void remote.refetch()}
          tintColor={colors.accent}
        />
      }
    >
      <Card>
        <Title>{t.settings.panel}</Title>
        {isConfigured(connection) ? (
          <>
            <Mono numberOfLines={2}>{connection.url}</Mono>
            <Muted>{remote.isError ? t.settings.offline : t.settings.online}</Muted>
          </>
        ) : (
          <Muted>{t.settings.notPaired}</Muted>
        )}
        <Row gap={space.sm}>
          <Button
            title={isConfigured(connection) ? t.settings.repair : t.settings.pair}
            tone="accent"
            onPress={() => router.push('/pair')}
            style={styles.grow}
          />
          {isConfigured(connection) ? (
            <Button
              title={t.settings.disconnect}
              tone="danger"
              onPress={() => void clearConnection()}
              style={styles.grow}
            />
          ) : null}
        </Row>
      </Card>

      <Card>
        <Title>{t.settings.language}</Title>
        <Row gap={space.sm}>
          {LANGUAGES.map((item) => (
            <Pressable
              key={item.value}
              onPress={() => setLanguage(item.value)}
              style={[styles.lang, language === item.value && styles.langOn]}
            >
              <Text style={styles.langText}>
                {item.value === 'ru' ? t.settings.languageRu : t.settings.languageEn}
              </Text>
            </Pressable>
          ))}
        </Row>
      </Card>

      <Card>
        <Title>{t.settings.notifications}</Title>
        <Muted>{t.settings.notificationsAbout}</Muted>
        <Button
          title={t.settings.enableHere}
          onPress={() => void enablePush()}
          busy={busy}
          disabled={!isConfigured(connection)}
        />
        {push ? <Mono style={styles.note}>{push}</Mono> : null}

        {status ? (
          <>
            <Pressable
              onPress={() => update.mutate({ notify: !status.notify })}
              style={styles.toggle}
            >
              <Text style={styles.toggleText}>
                {status.notify ? '✓ ' : '  '}
                {t.settings.panelNotifies}
              </Text>
            </Pressable>
            <Button
              title={t.settings.testNotification}
              onPress={() => test.mutate()}
              busy={test.isPending}
              disabled={status.devices.length === 0}
            />
            {test.data ? <Muted>{t.settings.sentTo(test.data.devices)}</Muted> : null}
            {test.error ? <Mono style={styles.failed}>{test.error.message}</Mono> : null}
          </>
        ) : null}
      </Card>

      {status && status.devices.length > 0 ? (
        <Card>
          <Title>{t.settings.devices}</Title>
          {status.devices.map((device) => (
            <Row key={device.token} gap={space.sm}>
              <View style={styles.grow}>
                <Text style={styles.name}>{device.label || device.platform}</Text>
                <Muted>{device.registeredAt.slice(0, 16).replace('T', ' ')}</Muted>
              </View>
              <Pressable onPress={() => forget.mutate(device.token)}>
                <Muted>{t.settings.forget}</Muted>
              </Pressable>
            </Row>
          ))}
        </Card>
      ) : null}

      {status ? (
        <Card>
          <Title>{t.settings.outside}</Title>
          <Muted>{status.enabled ? t.settings.outsideOn : t.settings.outsideOff}</Muted>
          {status.detectedUrl ? (
            <Mono numberOfLines={2}>
              Tailscale: {status.detectedUrl}
              {status.serveActive ? t.settings.serveOn : t.settings.serveOff}
            </Mono>
          ) : (
            <Muted>{t.settings.noTailscale}</Muted>
          )}
        </Card>
      ) : null}

      <Muted>
        {Constants.expoConfig?.name} {Constants.expoConfig?.version}
      </Muted>
    </Screen>
  );
}

const LANGUAGES: { value: Language }[] = [{ value: 'ru' }, { value: 'en' }];

const styles = StyleSheet.create({
  grow: { flex: 1 },
  lang: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  langOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  langText: { color: colors.text, fontSize: font.body },
  name: { color: colors.text, fontSize: font.body },
  note: { color: colors.warning },
  failed: { color: colors.danger },
  toggle: { paddingVertical: space.xs },
  toggleText: { color: colors.text, fontSize: font.body },
});
