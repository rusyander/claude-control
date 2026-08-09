import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Mono, Row, Title } from '../../shared/ui';
import { colors, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { decidePermission, type PendingPermission } from '../../shared/lib/runs';

/**
 * Запрос агента на разрешение. Ради этой карточки телефон и нужен: работа стоит,
 * пока человек не ответит, а человек в этот момент не за столом.
 *
 * Вход инструмента показывается как есть, без сокращений и красивого разбора:
 * решение «пускать ли» принимается по тому, ЧТО именно будет сделано, и любая
 * попытка это упростить кончилась бы разрешением вслепую.
 */
export function PermissionCard({
  chatId,
  permission,
}: {
  chatId: string;
  permission: PendingPermission;
}) {
  const t = useT();
  const [busy, setBusy] = useState<'allow' | 'deny' | undefined>();
  const [failed, setFailed] = useState('');

  const decide = (behavior: 'allow' | 'deny') => {
    setBusy(behavior);
    setFailed('');
    void decidePermission(chatId, permission.toolUseId, behavior)
      .catch((error: unknown) =>
        setFailed(error instanceof Error ? error.message : t.chat.permissionFailed),
      )
      .finally(() => setBusy(undefined));
  };

  const input = JSON.stringify(permission.input, null, 2);

  return (
    <View style={styles.card}>
      <Title>{t.chat.permission}</Title>
      <Mono style={styles.tool}>{permission.toolName}</Mono>
      <Mono numberOfLines={12}>{input}</Mono>
      {failed ? <Mono style={styles.failed}>{failed}</Mono> : null}
      <Row gap={space.sm}>
        <Button
          title={t.chat.allow}
          tone="accent"
          onPress={() => decide('allow')}
          busy={busy === 'allow'}
          disabled={Boolean(busy)}
          style={styles.grow}
        />
        <Button
          title={t.chat.deny}
          tone="danger"
          onPress={() => decide('deny')}
          busy={busy === 'deny'}
          disabled={Boolean(busy)}
          style={styles.grow}
        />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  tool: { color: colors.warning },
  failed: { color: colors.danger },
  grow: { flex: 1 },
});
