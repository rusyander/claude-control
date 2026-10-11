import type { ChatMessage } from '@agentdeck/contracts';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ApiError } from '../../../shared/api/client';
import { useT } from '../../../shared/config/i18n';
import { colors, space } from '../../../shared/config/theme';
import { Field, Icon, Row } from '../../../shared/ui';
import { useOutsideMessages, useSendOutsideMessage } from '../../../entities/chat/outsideMessages';
import { stepFinishedSince } from './hookSilent';
import { styles } from './OutsideComposer.styles';

/**
 * Поле ввода хода, идущего в терминале или VS Code. Сообщение панели начало бы
 * второй ход рядом, поэтому написанное встаёт в очередь сессии, и хук панели
 * отдаёт его агенту после ближайшего шага — тот читает его, не дожидаясь конца
 * хода. Под полем — что ещё ждёт шага, а что уже передано. `transcript` — лента
 * той же сессии: по ней видно, был ли шаг, после которого хук обязан был отозваться.
 */
export function OutsideComposer({
  sessionId,
  transcript,
}: {
  sessionId: string;
  transcript: ChatMessage[];
}) {
  const t = useT();
  const [text, setText] = useState('');
  const messages = useOutsideMessages(sessionId);
  const send = useSendOutsideMessage(sessionId);
  const list = messages.data?.messages ?? [];
  const oldestWaiting = list.find((message) => message.deliveredAt === undefined);
  const unhooked =
    messages.data?.hooked === false &&
    oldestWaiting !== undefined &&
    stepFinishedSince(transcript, oldestWaiting.queuedAt);
  const sendOff = send.isPending || text.trim().length === 0;
  const off = send.error instanceof ApiError && send.error.status === 409;

  const onSend = (): void => {
    if (sendOff) return;
    send.mutate(text.trim(), { onSuccess: () => setText('') });
  };

  return (
    <View style={styles.root}>
      <Row gap={space.sm} style={styles.notice}>
        <Icon ios="desktopcomputer" android="computer" size={18} color={colors.running} />
        <Text style={styles.noticeText}>{t.chat.outside}</Text>
      </Row>
      {list.map((message) => (
        <Row key={message.id} gap={space.sm} style={styles.message}>
          <Text style={styles.messageText} numberOfLines={2}>
            {message.text}
          </Text>
          <Text style={message.deliveredAt ? styles.delivered : styles.waiting}>
            {message.deliveredAt ? t.chat.outsideDelivered : t.chat.outsideWaiting}
          </Text>
        </Row>
      ))}
      {unhooked ? <Text style={styles.warn}>{t.chat.outsideUnhooked}</Text> : null}
      {send.error ? (
        <Text style={styles.failed}>{off ? t.chat.outsideOff : send.error.message}</Text>
      ) : null}
      <Row gap={space.sm} style={styles.bar}>
        <Field
          value={text}
          onChangeText={setText}
          placeholder={t.chat.outsidePlaceholder}
          multiline
          autoCapitalize="sentences"
          style={styles.input}
        />
        <Pressable
          onPress={onSend}
          disabled={sendOff}
          accessibilityRole="button"
          accessibilityLabel={t.composer.send}
          style={({ pressed }) => [
            styles.send,
            sendOff && styles.sendOff,
            pressed && styles.pressed,
          ]}
        >
          {send.isPending ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Icon ios="arrow.up" android="arrow_upward" size={22} color="#ffffff" />
          )}
        </Pressable>
      </Row>
    </View>
  );
}
