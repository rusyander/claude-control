import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../shared/config/i18n';
import { useChatGroupSettings } from '../../../entities/chat/group-settings';
import { unreadEscalations } from '../../../entities/chat/unreadEscalations';
import { useMarkEscalationsRead } from '../../../entities/chat/useMarkEscalationsRead';
import { useChatEscalations } from '../../../entities/chat/useChatEscalations';
import { styles } from './ChatGroupNotes.styles';

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
