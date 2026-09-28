import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import {
  unreadEscalations,
  useChatEscalations,
  useChatGroupSettings,
  useMarkEscalationsRead,
} from '../../entities/chat/group-settings';

/**
 * Над лентой разговора: группа и автономность чата одной строкой (менять — в
 * меню чата панели) и карточка критичного от детей разделения, если это
 * главный чат дерева. Карточка держится до «Прочитано», как в панели: открыть
 * разговор — ещё не значит разобраться.
 */
export function ChatGroupNotes({ chatId, sessionId }: { chatId: string; sessionId?: string }) {
  const t = useT();
  const settings = useChatGroupSettings(chatId, sessionId);
  const escalations = useChatEscalations();
  const markRead = useMarkEscalationsRead();
  const unread = unreadEscalations(escalations.data, [chatId, sessionId]);
  const view = settings.data;
  // Ключ группы `global:<id>` / `project:<id>` (GroupKey в контрактах) — имя
  // показывает панель; телефону хватает id: он узнаваем и не требует списка
  // групп. Снимается только префикс области — id с «:» остаётся целым.
  const group =
    view && view.groupChoice !== 'auto'
      ? view.groupChoice.replace(/^(?:global|project):/, '')
      : t.chat.groupAuto;

  return (
    <View style={styles.root}>
      {view ? (
        <Text style={styles.line} testID="chat-group-line">
          {t.chat.groupLine(group, view.autonomous)}
        </Text>
      ) : null}
      {unread.length > 0 ? (
        <View style={styles.card} testID="escalation-notice">
          {unread.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              <Text style={styles.title}>{t.chat.escalation.title(entry.childTitle)}</Text>
              <Text style={styles.text}>{entry.text}</Text>
              <Text style={styles.line}>
                {entry.source === 'block'
                  ? t.chat.escalation.fromBlock
                  : t.chat.escalation.fromAutoPick}
              </Text>
            </View>
          ))}
          <Pressable
            onPress={() => markRead.mutate({ chatId, ...(sessionId ? { sessionId } : {}) })}
            disabled={markRead.isPending}
            style={styles.dismiss}
            accessibilityRole="button"
          >
            <Text style={styles.dismissText}>{t.chat.escalation.dismiss}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.xs },
  line: { color: colors.textDim, fontSize: font.small },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    borderRadius: 6,
    padding: space.sm,
    gap: space.sm,
  },
  entry: { gap: 2 },
  title: { color: colors.text, fontSize: font.small, fontWeight: '700' },
  text: { color: colors.text, fontSize: font.small },
  dismiss: { alignSelf: 'flex-end', paddingVertical: space.xs, paddingHorizontal: space.sm },
  dismissText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
});
