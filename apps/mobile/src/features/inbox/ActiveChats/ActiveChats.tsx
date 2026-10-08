import { Text, View } from 'react-native';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Mono, Row } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { type ProjectGroup } from '../../../entities/inbox/model';
import { styles } from './ActiveChats.styles';
import { ChatRow } from './ChatRow/ChatRow';

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
