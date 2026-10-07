import { useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
// Своя KeyboardAvoidingView, как у чата Claude: системная с edge-to-edge молчит.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Button, Field, Loading, Mono, Muted, Row } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { dict, useT } from '../src/shared/config/i18n';
import { notifyLocally } from '../src/shared/lib/notifications';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import {
  fetchForeignStatus,
  foreignKeys,
  useForeignChat,
  useForeignStatus,
  useProviders,
  useSendForeign,
  useStopForeign,
  waitForeignStatus,
} from '../src/entities/provider-chat/api';
import {
  canWrite,
  editsState,
  sendMode,
  watchInBackground,
} from '../src/entities/provider-chat/model';
import { ForeignFeed } from '../src/features/chat/foreign/ForeignFeed';
import { ForeignAsks } from '../src/features/chat/foreign/ForeignAsks';

/**
 * Разговор с чужим CLI (Codex, Qwen Code…). Открывается из списка разговоров и
 * по нажатию на уведомление (`provider` + `id`). Писать можно только активным
 * CLI панели; разговор другого CLI читается и говорит, почему молчит.
 */
export default function ForeignChatScreen() {
  const t = useT().foreignChat;
  const params = useLocalSearchParams<{ provider?: string; id?: string }>();
  const providerId = params.provider ?? '';
  const chatId = params.id ?? '';
  const client = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);
  const [draft, setDraft] = useState('');

  const providers = useProviders();
  const active = providers.data?.active;
  const nameOf = (id: string | undefined): string =>
    providers.data?.providers.find((provider) => provider.id === id)?.name ?? id ?? '';
  const writable = canWrite(active, providerId);

  // Активный CLI мог смениться на компьютере, пока телефон лежал в фоне, а
  // нажатие на уведомление ведёт сюда сразу: перечитать его при открытии и при
  // каждом возврате, иначе поле ввода осталось бы у чата, писать в который нельзя.
  useEffect(() => {
    const reread = (): void => void client.invalidateQueries({ queryKey: ['providers'] });
    reread();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') reread();
    });
    return () => subscription.remove();
  }, [client]);

  const chat = useForeignChat(providerId, chatId);
  const status = useForeignStatus(providerId, chatId, writable);
  const send = useSendForeign(providerId, chatId);
  const stop = useStopForeign(providerId, chatId);

  const running = Boolean(status.data?.isRunning);
  // Ход кончился — реплика ответа уже в файле: перечитать разговор.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running)
      void client.invalidateQueries({ queryKey: foreignKeys.chat(providerId, chatId) });
    wasRunning.current = running;
  }, [running, client, providerId, chatId]);

  // Приложение ушло в фон посреди хода: конец ответа и просьба о разрешении —
  // в шторку, нажатие вернёт в этот разговор. Опрос по часам в фоне спит, поэтому
  // следит длинный опрос сервера (`watchInBackground`). Удалённый путь (push)
  // несёт тот же ключ.
  const latest = useRef({ status: status.data, chat: chat.data, writable });
  latest.current = { status: status.data, chat: chat.data, writable };
  useEffect(() => {
    let watching = false;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' || watching || !latest.current.writable) return;
      watching = true;
      void watchInBackground({
        initial: latest.current.status,
        fetchStatus: () => waitForeignStatus(chatId),
        fetchNow: () => fetchForeignStatus(chatId),
        stillAway: () => AppState.currentState !== 'active',
        onSignal: (signal, next) => {
          client.setQueryData(foreignKeys.status(providerId, chatId), next);
          const words = dict();
          const { chat: current } = latest.current;
          void notifyLocally(
            signal === 'permission' ? words.foreignChat.permission : words.run.finished,
            current?.title ?? providerId,
            { chatId: foreignChatKey(providerId, chatId), projectPath: current?.workdir ?? '' },
          ).catch(() => undefined);
        },
      }).finally(() => {
        watching = false;
      });
    });
    return () => subscription.remove();
  }, [client, providerId, chatId]);

  const mode = sendMode(status.data);
  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    send.mutate(text, {
      onSuccess: () => {
        setDraft('');
        void status.refetch();
      },
    });
  };

  const title = chat.data?.title ?? nameOf(providerId);
  const edits = editsState(
    providers.data?.providers.find((provider) => provider.id === providerId),
    chat.data?.allowEdits,
  );

  return (
    <>
      <Stack.Screen options={{ title }} />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {chat.isLoading ? <Loading /> : null}
          {chat.isError ? <Mono style={styles.error}>{t.notFound}</Mono> : null}
          {chat.data ? (
            <>
              <Muted>
                {nameOf(providerId)}
                {chat.data.workdir ? ` · ${chat.data.workdir}` : ''}
              </Muted>
              <Muted>{edits === 'cli' ? t.edits.cli(nameOf(providerId)) : t.edits[edits]}</Muted>
              <ForeignFeed
                messages={chat.data.messages}
                partial={status.data?.partial ?? ''}
                running={running}
              />
            </>
          ) : null}
          {writable ? (
            <ForeignAsks
              providerId={providerId}
              chatId={chatId}
              permissions={status.data?.permissions ?? []}
              queued={status.data?.queued ?? []}
              queueHeld={Boolean(status.data?.queueHeld)}
            />
          ) : null}
        </ScrollView>

        {!writable && providers.data && chat.data ? (
          <View style={styles.composer}>
            <Text style={styles.readOnly}>{t.readOnly(nameOf(providerId), nameOf(active))}</Text>
          </View>
        ) : null}
        {writable && chat.data ? (
          <View style={styles.composer}>
            {send.error ? (
              <Mono style={styles.error}>
                {t.sendFailed}: {send.error.message}
              </Mono>
            ) : null}
            <Field
              value={draft}
              onChangeText={setDraft}
              placeholder={t.placeholder}
              multiline
              autoCapitalize="sentences"
            />
            <Row gap={space.sm}>
              <Button
                title={{ send: t.send, steer: t.steer, queue: t.queue }[mode]}
                tone="accent"
                onPress={submit}
                busy={send.isPending}
                disabled={!draft.trim()}
                style={styles.grow}
              />
              {running ? (
                <Button
                  title={t.stop}
                  tone="danger"
                  onPress={() => stop.mutate()}
                  busy={stop.isPending}
                />
              ) : null}
            </Row>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  feed: { padding: space.md, gap: space.md },
  grow: { flex: 1 },
  error: { color: colors.danger },
  readOnly: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
  composer: {
    padding: space.md,
    gap: space.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
