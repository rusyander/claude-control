import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { useT } from '../../../../shared/config/i18n';
import { askKinds } from '../../../../entities/inbox/askKinds';
import { Pressable, View, Text } from 'react-native';
import { styles } from '../ActiveChats.styles';
import { StatusDot, Row } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';
import { ageMinutes } from '../../../../entities/inbox/ageMinutes';

export function ChatRow({
  chat,
  now,
  first,
  onPress,
}: {
  chat: InboxChat;
  now: number;
  first: boolean;
  onPress: () => void;
}) {
  const t = useT();
  const asks = chat.asks.length;
  const kinds = askKinds(chat.asks);
  const status = t.home.status[chat.status];
  // «молчит» на каждой второй строке — шум: серая точка уже это говорит, а
  // место нужнее последней реплике. Слово остаётся там, где оно и есть новость.
  const showStatus = chat.status !== 'idle' || !chat.preview;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chat.title}, ${status}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !first && styles.rowDivided, pressed && styles.pressed]}
    >
      <View style={styles.dot}>
        <StatusDot status={chat.status} />
      </View>
      <View style={styles.body}>
        <Row gap={space.sm}>
          <Text style={styles.title} numberOfLines={1}>
            {chat.title}
          </Text>
          <Text style={styles.age}>{t.home.age(ageMinutes(chat.updatedAt, now))}</Text>
        </Row>
        <Row gap={space.sm}>
          {showStatus ? (
            <Text
              style={[
                styles.status,
                chat.status === 'waiting' && styles.statusWaiting,
                chat.status === 'running' && styles.statusRunning,
              ]}
            >
              {status}
            </Text>
          ) : null}
          {asks > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {t.home.asksBadge(kinds.questions, kinds.permissions)}
              </Text>
            </View>
          ) : null}
          {chat.preview ? (
            <Text style={styles.preview} numberOfLines={1}>
              {chat.preview}
            </Text>
          ) : null}
        </Row>
      </View>
    </Pressable>
  );
}
