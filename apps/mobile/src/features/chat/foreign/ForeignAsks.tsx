import { StyleSheet, View } from 'react-native';
import type { ProviderChatPermission, ProviderChatQueued } from '@agentdeck/contracts';
import { Button, Mono, Muted, Row, Title } from '../../../shared/ui';
import { colors, space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import {
  useAnswerForeignPermission,
  useSendQueuedForeign,
} from '../../../entities/provider-chat/api';

/**
 * То, что ждёт человека в разговоре с чужим CLI: просьбы о разрешении (ход
 * стоит, пока не ответят) и очередь сообщений до конца ответа. Просьба несёт
 * только то, что CLI прислал по проводу, — имя инструмента и его описание.
 */
export function ForeignAsks({
  providerId,
  chatId,
  permissions,
  queued,
  queueHeld,
}: {
  providerId: string;
  chatId: string;
  permissions: ProviderChatPermission[];
  queued: ProviderChatQueued[];
  queueHeld: boolean;
}) {
  const t = useT().foreignChat;
  const answer = useAnswerForeignPermission(providerId, chatId);
  const sendQueued = useSendQueuedForeign(chatId);

  return (
    <>
      {permissions.map((ask) => (
        <View key={ask.id} style={styles.card}>
          <Title>{t.permission}</Title>
          {ask.tool ? <Mono style={styles.tool}>{ask.tool}</Mono> : null}
          {ask.title ? <Mono numberOfLines={12}>{ask.title}</Mono> : null}
          {answer.error ? <Mono style={styles.failed}>{answer.error.message}</Mono> : null}
          <Row gap={space.sm}>
            <Button
              title={t.allow}
              tone="accent"
              onPress={() => answer.mutate({ askId: ask.id, decision: 'allow' })}
              busy={answer.isPending && answer.variables?.decision === 'allow'}
              disabled={answer.isPending}
              style={styles.grow}
            />
            <Button
              title={t.deny}
              tone="danger"
              onPress={() => answer.mutate({ askId: ask.id, decision: 'deny' })}
              busy={answer.isPending && answer.variables?.decision === 'deny'}
              disabled={answer.isPending}
              style={styles.grow}
            />
          </Row>
        </View>
      ))}

      {queued.length > 0 ? (
        <View style={styles.queue}>
          <Muted>{queueHeld ? t.queueHeld : t.queued}</Muted>
          {queued.map((item) => (
            <Row key={item.id} gap={space.sm}>
              <Mono numberOfLines={2} style={styles.grow}>
                {item.text}
              </Mono>
              {queueHeld ? (
                <Button
                  title={t.sendQueued}
                  onPress={() => sendQueued.mutate(item.id)}
                  busy={sendQueued.isPending && sendQueued.variables === item.id}
                  disabled={sendQueued.isPending}
                />
              ) : null}
            </Row>
          ))}
          {sendQueued.error ? <Mono style={styles.failed}>{sendQueued.error.message}</Mono> : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: space.md,
    gap: space.sm,
  },
  tool: { color: colors.warning },
  failed: { color: colors.danger },
  grow: { flex: 1 },
  queue: { gap: space.xs },
});
