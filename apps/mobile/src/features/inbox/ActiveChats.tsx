import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Mono, Row, StatusDot } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { ageMinutes, askKinds, type ProjectGroup } from '../../entities/inbox/model';

/**
 * «Проекты и чаты»: живые разговоры, сгруппированные по проекту. Строка —
 * статус, название, свежесть и число вопросов; нажатие открывает сам чат.
 */
export function ActiveChats({
  groups,
  now,
  onOpen,
}: {
  groups: readonly ProjectGroup[];
  now: number;
  onOpen: (chat: InboxChat) => void;
}) {
  const t = useT();
  return (
    <View style={styles.list}>
      {groups.map((group) => {
        const counts = t.home.groupCounts(group.waiting, group.running);
        return (
          <View key={group.key} style={styles.group}>
            <Row gap={space.sm} style={styles.groupHead}>
              <Text style={styles.groupName} numberOfLines={1}>
                {group.isSandbox ? t.home.sandbox : group.name}
              </Text>
              {counts ? <Mono style={styles.counts}>{counts}</Mono> : null}
            </Row>
            <View style={styles.rows}>
              {group.chats.map((chat, index) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  now={now}
                  first={index === 0}
                  onPress={() => onOpen(chat)}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ChatRow({
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
          <Mono style={styles.age}>{t.home.age(ageMinutes(chat.updatedAt, now))}</Mono>
        </Row>
        <Row gap={space.sm}>
          <Text
            style={[
              styles.status,
              chat.status === 'waiting' && styles.statusWaiting,
              chat.status === 'running' && styles.statusRunning,
            ]}
          >
            {status}
          </Text>
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

const styles = StyleSheet.create({
  list: { gap: space.lg },
  group: { gap: space.xs },
  groupHead: { paddingHorizontal: space.xs },
  groupName: { color: colors.text, fontSize: font.title, fontWeight: '600', flexShrink: 1 },
  counts: { marginLeft: 'auto' },
  rows: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    minHeight: 56,
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  pressed: { backgroundColor: colors.surfaceRaised },
  dot: { paddingTop: 6 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600', flex: 1 },
  age: { color: colors.textFaint },
  status: { color: colors.textFaint, fontSize: font.small },
  statusWaiting: { color: colors.waiting },
  statusRunning: { color: colors.running },
  badge: {
    backgroundColor: colors.waiting,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  preview: { color: colors.textDim, fontSize: font.small, flex: 1 },
});
