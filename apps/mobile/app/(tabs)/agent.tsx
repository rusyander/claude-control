import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Card, Chips, Empty, Field, Loading, Mono, Muted, Row, Title } from '../../src/shared/ui';
import { colors, font, radius, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { isConfigured, useConnection } from '../../src/shared/api/connection';
import { useWorkspace } from '../../src/shared/lib/workspace';
import { useVoice } from '../../src/shared/lib/voice';
import { appendDictation } from '../../src/entities/panel-agent/model';
import {
  PENDING_POLL_MS,
  usePanelAgentConversations,
  usePanelAgentJournal,
  usePanelAgentPending,
} from '../../src/entities/panel-agent/api';
import { AgentPendingCard } from '../../src/features/panel-agent/AgentPendingCard';
import { useAgentSession } from '../../src/features/panel-agent/useAgentSession';
import { SafeAreaView } from 'react-native-safe-area-context';

type AgentView = 'conversation' | 'history' | 'journal';

/**
 * Агент панели на телефоне (А8): тот же агент и те же карточки, что в окне панели
 * на компьютере. Карточку можно решить отсюда или там — кто первый, того и
 * решение; второй получит «уже решено».
 *
 * Голос — системное распознавание телефона (`useVoice`, как в чате): текст
 * ложится в поле, отправляет человек.
 */
export default function AgentScreen() {
  const t = useT();
  const connection = useConnection();
  const workspace = useWorkspace();
  const [view, setView] = useState<AgentView>('conversation');
  const session = useAgentSession(workspace.projectPath || undefined);
  const pending = usePanelAgentPending(PENDING_POLL_MS.open);
  const conversations = usePanelAgentConversations(view === 'history');
  const journal = usePanelAgentJournal(view === 'journal');
  const [text, setText] = useState('');
  const typed = useRef('');
  const scrollRef = useRef<ScrollView>(null);

  // Распознавание отдаёт всю фразу сессии каждый раз: дописываем к набранному
  // ДО нажатия микрофона, а не к прошлому промежуточному результату.
  const voice = useVoice((heard) => setText(appendDictation(typed.current, heard)));
  const toggleVoice = (): void => {
    if (!voice.listening) typed.current = text.trim();
    voice.toggle();
  };

  if (!isConfigured(connection)) return <Empty text={t.common.notConnectedChat} />;

  const { state } = session;
  const cards = pending.data ?? [];
  const sendOff = !text.trim() || state.running || voice.listening;

  const send = (): void => {
    if (sendOff) return;
    const message = text.trim();
    setText('');
    typed.current = '';
    void session.send(message);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Title>{t.agent.title}</Title>
        <Muted>{t.agent.subtitle}</Muted>
        <Chips
          options={[
            { value: 'conversation', label: t.agent.views.conversation },
            { value: 'history', label: t.agent.views.history },
            { value: 'journal', label: t.agent.views.journal },
          ]}
          value={view}
          onChange={setView}
        />
        {cards.length > 0 && view !== 'conversation' ? (
          <Pressable accessibilityRole="button" onPress={() => setView('conversation')}>
            <Mono style={styles.badge}>{t.agent.pendingBadge(cards.length)}</Mono>
          </Pressable>
        ) : null}
      </View>

      {view === 'conversation' ? (
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <ScrollView
            ref={scrollRef}
            style={styles.flex}
            contentContainerStyle={styles.feed}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          >
            <Row gap={space.sm} style={styles.wrap}>
              {workspace.projectPath ? <Mono>{t.agent.context(workspace.projectPath)}</Mono> : null}
              {state.feed.length > 0 ? (
                <Pressable accessibilityRole="button" onPress={session.reset}>
                  <Text style={styles.link}>{t.agent.newConversation}</Text>
                </Pressable>
              ) : null}
            </Row>

            {state.feed.length === 0 && cards.length === 0 ? <Muted>{t.agent.empty}</Muted> : null}

            {state.feed.map((item) => {
              if (item.kind === 'user' || item.kind === 'assistant') {
                return (
                  <View
                    key={item.id}
                    style={[styles.bubble, item.kind === 'user' ? styles.user : styles.assistant]}
                  >
                    <Text style={styles.bubbleText}>{item.text}</Text>
                  </View>
                );
              }
              if (item.kind === 'tool' || item.kind === 'tool-error') {
                return (
                  <Mono key={item.id} style={item.kind === 'tool' ? undefined : styles.error}>
                    {item.kind === 'tool'
                      ? t.agent.toolCalled(item.text)
                      : t.agent.toolFailed(item.text)}
                  </Mono>
                );
              }
              return (
                <Mono key={item.id} style={item.kind === 'error' ? styles.error : undefined}>
                  {item.text}
                </Mono>
              );
            })}

            {state.running ? <Muted>{t.agent.thinking}</Muted> : null}

            {cards.map((card) => (
              <AgentPendingCard key={card.id} pending={card} />
            ))}
          </ScrollView>

          {voice.listening || voice.problem ? (
            <Mono style={voice.problem ? styles.error : styles.listening}>
              {voice.problem || t.composer.voiceListening}
            </Mono>
          ) : null}
          <Row gap={space.sm} style={styles.bar}>
            <Field
              value={text}
              onChangeText={(next) => {
                typed.current = next.trim();
                setText(next);
              }}
              placeholder={t.agent.placeholder}
              multiline
              autoCapitalize="sentences"
              style={styles.input}
            />
            <Pressable
              onPress={toggleVoice}
              accessibilityRole="button"
              accessibilityLabel={t.composer.voice}
              accessibilityState={{ selected: voice.listening }}
              style={({ pressed }) => [
                styles.round,
                styles.mic,
                voice.listening && styles.micOn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.roundText}>🎙</Text>
            </Pressable>
            {state.running ? (
              <Pressable
                onPress={session.stop}
                accessibilityRole="button"
                accessibilityLabel={t.agent.stop}
                style={({ pressed }) => [styles.round, styles.stop, pressed && styles.pressed]}
              >
                <View style={styles.stopMark} />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={sendOff}
                accessibilityRole="button"
                accessibilityLabel={t.agent.send}
                accessibilityState={{ disabled: sendOff }}
                style={({ pressed }) => [
                  styles.round,
                  styles.send,
                  sendOff && styles.off,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.roundText}>↑</Text>
              </Pressable>
            )}
          </Row>
        </KeyboardAvoidingView>
      ) : null}

      {view === 'history' ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.feed}
          refreshControl={
            <RefreshControl
              refreshing={conversations.isRefetching}
              onRefresh={() => void conversations.refetch()}
            />
          }
        >
          {conversations.isLoading ? <Loading /> : null}
          {conversations.isError ? (
            <Mono style={styles.error}>{t.agent.history.failed}</Mono>
          ) : null}
          {conversations.data?.length === 0 ? <Empty text={t.agent.history.empty} /> : null}
          {(conversations.data ?? []).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() => {
                void session.open(item.id).then(() => setView('conversation'));
              }}
            >
              <Card>
                <Text style={styles.bubbleText} numberOfLines={2}>
                  {item.title}
                </Text>
                <Muted>
                  {new Date(item.updatedAt).toLocaleString()} ·{' '}
                  {t.agent.history.messages(item.messages)}
                </Muted>
              </Card>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {view === 'journal' ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.feed}
          refreshControl={
            <RefreshControl
              refreshing={journal.isRefetching}
              onRefresh={() => void journal.refetch()}
            />
          }
        >
          {journal.isLoading ? <Loading /> : null}
          {journal.isError ? <Mono style={styles.error}>{t.agent.journal.failed}</Mono> : null}
          {journal.data?.length === 0 ? <Empty text={t.agent.journal.empty} /> : null}
          {(journal.data ?? []).map((entry, index) => (
            <Card key={`${entry.at}-${index}`}>
              <Row gap={space.sm} style={styles.wrap}>
                <Mono style={entry.outcome === 'done' ? styles.ok : styles.warn}>
                  {t.agent.outcome[entry.outcome] ?? entry.outcome}
                </Mono>
                <Mono>{entry.name}</Mono>
              </Row>
              <Text style={styles.bubbleText}>{entry.summary}</Text>
              <Muted>
                {new Date(entry.at).toLocaleString()} · {t.agent.decidedBy[entry.decidedBy]}
              </Muted>
            </Card>
          ))}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  header: {
    padding: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  badge: { color: colors.warning },
  feed: { padding: space.lg, gap: space.sm },
  wrap: { flexWrap: 'wrap' },
  link: { color: colors.accent, fontSize: font.body },
  bubble: { borderRadius: radius.md, padding: space.md, maxWidth: '90%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.accentDim },
  assistant: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  bubbleText: { color: colors.text, fontSize: font.body, lineHeight: 20 },
  error: { color: colors.danger },
  warn: { color: colors.warning },
  ok: { color: colors.success },
  listening: { color: colors.accent, paddingHorizontal: space.lg },
  bar: {
    padding: space.sm,
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, maxHeight: 140 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mic: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border },
  micOn: { backgroundColor: colors.danger, borderColor: colors.danger },
  send: { backgroundColor: colors.accent },
  stop: { backgroundColor: colors.danger },
  stopMark: { width: 14, height: 14, borderRadius: 2, backgroundColor: colors.text },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  roundText: { color: colors.text, fontSize: 20 },
});
