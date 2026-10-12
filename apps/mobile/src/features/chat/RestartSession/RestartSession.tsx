import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button, Row } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { styles } from './RestartSession.styles';

/**
 * «Чистая сессия» с телефона — та же кнопка, что в шапке чата панели. Действие
 * необратимо для разговора (продолжение уходит в новый), поэтому сначала
 * подтверждение на месте: системного диалога у шторки телефона нет, а случайное
 * касание по ленте не должно обрывать работу.
 *
 * Что именно запустится — решает сервер по активному CLI: Claude продолжает
 * сессией, чужой CLI — новым разговором в том же каталоге.
 */
export function RestartSession({ onRestart }: { onRestart: () => Promise<void> }) {
  const t = useT().chat.restart;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = (): void => {
    setBusy(true);
    setError('');
    void onRestart()
      .then(() => setConfirming(false))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.failed))
      .finally(() => setBusy(false));
  };

  if (!confirming) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setConfirming(true)}
        hitSlop={8}
        style={styles.link}
      >
        <Text style={styles.linkText}>{t.action}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.hint}>{t.confirm}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Row gap={space.sm}>
        <Button title={t.yes} tone="accent" onPress={run} busy={busy} style={styles.grow} />
        <Button
          title={t.cancel}
          tone="ghost"
          onPress={() => setConfirming(false)}
          disabled={busy}
        />
      </Row>
    </View>
  );
}
