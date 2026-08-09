import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Button, Card, Empty, Field, Loading, Mono, Muted, Row, Screen } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { newChatId, openChat, useWorkspace } from '../src/shared/lib/workspace';
import { useRuns, visibleStatus } from '../src/shared/lib/runs';
import { useChats } from '../src/entities/chat/api';

/**
 * Разговоры машины: те же транскрипты, что видит панель и терминал. Своей базы
 * нет ни у кого, поэтому список одинаков везде.
 *
 * Жёлтая точка — «агент задал вопрос и ждёт»: считается из транскрипта, а не из
 * живого прогона, поэтому видна и для разговора, который шёл в терминале.
 */
export default function ChatsScreen() {
  const t = useT();
  const router = useRouter();
  const workspace = useWorkspace();
  const chats = useChats();
  const runs = useRuns();
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const all = chats.data ?? [];
    if (!query) return all;
    return all.filter((chat) =>
      `${chat.title} ${chat.project} ${chat.preview ?? ''}`.toLowerCase().includes(query),
    );
  }, [chats.data, filter]);

  const open = (id: string, projectPath: string): void => {
    openChat(id, projectPath);
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: t.chats.title }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={chats.isFetching}
            onRefresh={() => void chats.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        <Button
          title={t.chats.newChat}
          tone="accent"
          onPress={() => open(newChatId(), workspace.projectPath)}
        />
        <Field value={filter} onChangeText={setFilter} placeholder={t.chats.search} />

        {chats.isLoading ? <Loading /> : null}
        {chats.isError ? <Mono style={styles.failed}>{t.common.panelSilent}</Mono> : null}
        {!chats.isLoading && visible.length === 0 ? <Empty text={t.chats.nothing} /> : null}

        {visible.slice(0, 100).map((chat) => {
          const run = runs.find((item) => item.id === chat.id);
          const status = run ? visibleStatus(run) : '';
          return (
            <Pressable key={chat.id} onPress={() => open(chat.id, chat.projectPath)}>
              <Card style={chat.id === workspace.chatId ? styles.current : undefined}>
                <Row gap={space.sm}>
                  <Text style={styles.title} numberOfLines={1}>
                    {chat.title}
                  </Text>
                  {chat.awaitingReply ? <View style={styles.waiting} /> : null}
                  {status === 'running' ? <View style={styles.running} /> : null}
                </Row>
                {chat.preview ? <Muted>{trim(chat.preview)}</Muted> : null}
                <Row gap={space.sm} style={styles.meta}>
                  <Mono style={styles.grow} numberOfLines={1}>
                    {chat.isSandbox ? t.chats.sandbox : chat.project}
                  </Mono>
                  <Mono>
                    {chat.messageCountPartial ? '+' : ''}
                    {t.chats.messages(chat.messageCount)}
                  </Mono>
                  <Mono>{chat.updatedAt.slice(0, 16).replace('T', ' ')}</Mono>
                </Row>
              </Card>
            </Pressable>
          );
        })}
      </Screen>
    </>
  );
}

function trim(preview: string): string {
  return preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600', flex: 1 },
  meta: { flexWrap: 'wrap' },
  current: { borderColor: colors.accent },
  waiting: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.waiting },
  running: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.running },
  failed: { color: colors.danger },
});
