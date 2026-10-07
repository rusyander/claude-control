import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Mono, Muted, Row, Title } from '../../../shared/ui';
import { colors, font, space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import {
  useCreateForeignChat,
  useForeignChats,
  useProviders,
} from '../../../entities/provider-chat/api';
import { foreignChatSection } from './foreignSection';

/**
 * Разговоры активного CLI панели, когда это не Claude: у Codex, Qwen Code и
 * других свой список в файлах панели, а не транскрипты Claude ниже. Активен
 * Claude или чат у CLI не готов (Cursor) — секции нет вовсе (`foreignChatSection`).
 */
export function ForeignChatsSection({ projectPath }: { projectPath: string }) {
  const t = useT().foreignChat;
  const router = useRouter();
  const providers = useProviders();
  const section = foreignChatSection(providers.data);
  // Скрытая секция и список не спрашивает: у CLI без чата его нет.
  const chats = useForeignChats(section?.id);
  const create = useCreateForeignChat();

  if (!section) return null;
  const { id: active, name } = section;
  const open = (id: string): void =>
    router.push({ pathname: '/foreign-chat', params: { provider: active, id } });

  return (
    <>
      <Title>{t.section(name)}</Title>
      <Button
        title={t.newChat(name)}
        onPress={() =>
          create.mutate(projectPath ? { workdir: projectPath } : {}, {
            onSuccess: (chat) => open(chat.id),
          })
        }
        busy={create.isPending}
      />
      {create.error ? <Mono style={styles.failed}>{create.error.message}</Mono> : null}
      {chats.data && chats.data.length === 0 ? <Muted>{t.nothing}</Muted> : null}
      {(chats.data ?? []).slice(0, 50).map((chat) => (
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

const styles = StyleSheet.create({
  grow: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { flexWrap: 'wrap' },
  failed: { color: colors.danger },
});
