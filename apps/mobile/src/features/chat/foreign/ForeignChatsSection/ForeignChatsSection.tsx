import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, Mono, Muted, Row, Title } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';
import { useT } from '../../../../shared/config/i18n';
import { useProviders } from '../../../../entities/provider-chat/api';
import { foreignChatSection } from '../foreignSection';
import { useForeignChats } from '../../../../entities/provider-chat/useForeignChats';
import { styles } from './ForeignChatsSection.styles';

/**
 * Старые разговоры активного CLI панели, когда это не Claude, — история (этап 10, F2c). Чат
 * любого CLI идёт через ядро, поэтому кнопки «Новый разговор» здесь нет: строка под заголовком
 * говорит, где он начинается. Активен Claude или чат у CLI не готов — секции нет вовсе.
 */
export function ForeignChatsSection() {
  const t = useT().foreignChat;
  const router = useRouter();
  const providers = useProviders();
  const section = foreignChatSection(providers.data);
  // Скрытая секция и список не спрашивает: у CLI без чата его нет.
  const chats = useForeignChats(section?.id);

  if (!section) return null;
  const { id: active, name } = section;
  const open = (id: string): void =>
    router.push({ pathname: '/foreign-chat', params: { provider: active, id } });
  const shown = chats.data ?? [];

  return (
    <>
      <Title>{t.section(name)}</Title>
      <Muted>{t.coreOnly(name)}</Muted>
      {chats.data && shown.length === 0 ? <Muted>{t.nothing}</Muted> : null}
      {shown.slice(0, 50).map((chat) => (
        <Pressable key={chat.id} onPress={() => open(chat.id)}>
          <Card>
            <Text style={styles.title} numberOfLines={1}>
              {chat.title}
            </Text>
            <Row gap={space.sm} style={styles.meta}>
              <Mono style={styles.grow} numberOfLines={1}>
                {chat.workdir ?? ''}
              </Mono>
              <Mono>{t.messages(chat.messageCount)}</Mono>
              <Mono>{chat.updatedAt.slice(0, 16).replace('T', ' ')}</Mono>
            </Row>
          </Card>
        </Pressable>
      ))}
    </>
  );
}
