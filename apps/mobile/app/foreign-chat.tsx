import { useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Loading, Mono, Muted } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useProviders } from '../src/entities/provider-chat/api';
import { ForeignFeed } from '../src/features/chat/foreign/ForeignFeed/ForeignFeed';
import { useForeignChat } from '../src/entities/provider-chat/useForeignChat';

/**
 * Старый разговор чужого CLI на телефоне — только чтение (этап 10, F2c). Чат любого CLI идёт
 * через ядро; этот разговор вела панель до переезда, и продолжить его той же сессией нельзя.
 * Ход, остановка, очередь, ответ на запрос прав и перезапуск ушли вместе с прежним
 * исполнителем — сервер отвечает на них отказом `provider-chat-core`, а экран их не предлагает.
 */
export default function ForeignChatScreen() {
  const t = useT().foreignChat;
  const params = useLocalSearchParams<{ provider?: string; id?: string }>();
  const providerId = params.provider ?? '';
  const chatId = params.id ?? '';
  const scrollRef = useRef<ScrollView>(null);

  const providers = useProviders();
  const nameOf = (id: string | undefined): string =>
    providers.data?.providers.find((provider) => provider.id === id)?.name ?? id ?? '';
  const chat = useForeignChat(providerId, chatId);
  const title = chat.data?.title ?? nameOf(providerId);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <View style={styles.flex}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {chat.isLoading ? <Loading /> : null}
          {chat.isError ? <Mono style={styles.error}>{t.notFound}</Mono> : null}
          {chat.data ? (
            <>
              <Muted>
                {nameOf(providerId)}
                {chat.data.workdir ? ` · ${chat.data.workdir}` : ''}
              </Muted>
              <ForeignFeed messages={chat.data.messages} />
            </>
          ) : null}
        </ScrollView>
        {chat.data ? (
          <View style={styles.footer}>
            <Text style={styles.readOnly}>{t.history(nameOf(providerId))}</Text>
          </View>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  feed: { padding: space.md, gap: space.md },
  error: { color: colors.danger },
  readOnly: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
  footer: {
    padding: space.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
