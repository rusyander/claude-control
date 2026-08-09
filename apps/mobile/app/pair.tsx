import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import type { RemotePairing } from '@claude-control/contracts';
import { Button, Card, Field, Mono, Muted, Screen, Title } from '../src/shared/ui';
import { colors, radius, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { bundledUrl, normalizeUrl, saveConnection } from '../src/shared/api/connection';
import { registerForPush } from '../src/shared/lib/notifications';

/**
 * Спаривание с панелью. QR-код панель рисует у себя в настройках; в нём адрес и
 * токен — то есть ровно то, что руками набирать долго и с опечатками.
 *
 * Ввод руками оставлен рядом намеренно: камера бывает запрещена, панель бывает
 * открыта на той же машине, а адрес в приватной сети иногда приходит из другого
 * места. Отказ камеры не должен запирать вход.
 */
export default function PairScreen() {
  const t = useT();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  // Адрес из сборки — стартовое значение, а не жёсткое: своё всегда можно вписать.
  const [url, setUrl] = useState(bundledUrl);
  const [token, setToken] = useState('');
  const [failed, setFailed] = useState('');
  const [saving, setSaving] = useState(false);
  const [scanned, setScanned] = useState(false);

  const connect = async (nextUrl: string, nextToken: string): Promise<void> => {
    const address = normalizeUrl(nextUrl);
    if (!address) {
      setFailed(t.pair.needAddress);
      return;
    }
    setSaving(true);
    setFailed('');
    try {
      await saveConnection(address, nextToken);
      // Push-токен отдаём сразу: пара «адрес + токен» уже есть, а второй заход в
      // настройки ради разрешения человек делать не станет.
      await registerForPush(t.settings.thisPhone);
      router.back();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : t.pair.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const onScan = (data: string): void => {
    if (scanned || saving) return;
    setScanned(true);
    try {
      const parsed = JSON.parse(data) as Partial<RemotePairing>;
      if (!parsed.url) throw new Error('нет адреса');
      setUrl(parsed.url);
      setToken(parsed.token ?? '');
      void connect(parsed.url, parsed.token ?? '');
    } catch {
      setFailed(t.pair.notPanelCode);
      setScanned(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: t.pair.title }} />
      <Screen scroll>
        <Card>
          <Title>{t.pair.fromPanel}</Title>
          <Muted>{t.pair.where}</Muted>
          {permission?.granted ? (
            <View style={styles.camera}>
              <CameraView
                style={styles.cameraView}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(event) => onScan(event.data)}
              />
            </View>
          ) : (
            <Button
              title={permission ? t.pair.allowCamera : t.pair.checkingCamera}
              onPress={() => void requestPermission()}
              disabled={!permission}
            />
          )}
        </Card>

        <Card>
          <Title>{t.pair.orManually}</Title>
          <Field value={url} onChangeText={setUrl} placeholder={t.pair.address} />
          <Field value={token} onChangeText={setToken} placeholder={t.pair.token} secure />
          <Button
            title={t.pair.connect}
            tone="accent"
            onPress={() => void connect(url, token)}
            busy={saving}
            disabled={!url.trim()}
          />
          {failed ? <Mono style={styles.failed}>{failed}</Mono> : null}
        </Card>

        <Muted>{t.pair.secretNote}</Muted>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  camera: {
    height: 280,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
    marginTop: space.xs,
  },
  cameraView: { flex: 1 },
  failed: { color: colors.danger },
});
