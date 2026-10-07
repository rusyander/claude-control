import { StyleSheet, Text, View } from 'react-native';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { colors, font, space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { AgentText } from '../AgentText';
import { Markdown } from '../Markdown';
import { UserBubble } from '../Transcript';

/**
 * Лента разговора с чужим CLI: реплики из файла панели и кусок ответа, который
 * ещё печатается. Карточек инструментов нет — чужой CLI их ни в какой транскрипт
 * не пишет, панель видит только текст.
 */
export function ForeignFeed({
  messages,
  partial,
  running,
}: {
  messages: ProviderChatMessage[];
  partial: string;
  running: boolean;
}) {
  const t = useT().foreignChat;
  return (
    <View style={styles.root}>
      {messages.map((message) => {
        if (message.role === 'notice')
          return (
            <Text key={message.id} style={styles.notice}>
              {t.notice}: {message.content}
            </Text>
          );
        if (message.role === 'user')
          return (
            <UserBubble key={message.id}>
              <Markdown>{message.content}</Markdown>
              {message.steered ? <Text style={styles.meta}>{t.steered}</Text> : null}
            </UserBubble>
          );
        return message.failed ? (
          <View key={message.id} style={styles.failed}>
            <Text style={styles.failedTitle}>{t.failed}</Text>
            <Text style={styles.failedText}>{message.content}</Text>
          </View>
        ) : (
          <AgentText key={message.id} text={message.content} />
        );
      })}
      {running ? (
        partial ? (
          <AgentText text={partial} streaming />
        ) : (
          <Text style={styles.meta}>{t.typing}</Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  notice: { color: colors.textDim, fontSize: font.small, fontStyle: 'italic', lineHeight: 18 },
  meta: { color: colors.textFaint, fontSize: font.small },
  failed: { gap: space.xs },
  failedTitle: { color: colors.danger, fontSize: font.small, fontWeight: '600' },
  failedText: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
});
