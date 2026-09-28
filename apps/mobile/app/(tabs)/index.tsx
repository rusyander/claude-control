import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Button, Empty, Loading, Muted } from '../../src/shared/ui';
import { colors, font, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { isConfigured, useConnection } from '../../src/shared/api/connection';
import { newChatId, openChat, useWorkspace } from '../../src/shared/lib/workspace';
import { usePullRefresh } from '../../src/shared/lib/pull-refresh';
import {
  pendingCount,
  projectGroups,
  stableChatKey,
  questionCards,
  staleSent,
  type QuestionCardData,
} from '../../src/entities/inbox/model';
import { ActiveChats } from '../../src/features/inbox/ActiveChats';
import { AskCard } from '../../src/features/inbox/AskCard';
import { localChatKey } from '../../src/features/inbox/chatKey';
import { forgetSent, useSent } from '../../src/features/inbox/sent';
import { useInboxChats } from '../../src/features/inbox/useInboxChats';
import { WatcherChip } from '../../src/features/watcher/WatcherChip';

type HomeTab = 'chats' | 'questions';

/** Раз в полминуты: «5 мин» не должны стоять на экране, пока прошло полчаса. */
const CLOCK_MS = 30_000;

/**
 * Главная: что идёт и кто ждёт — по всем проектам сразу.
 *
 * Телефон берут в руки, чтобы узнать, не стоит ли где работа на ответе
 * человека, и ответить. Раньше для этого приходилось открывать разговоры по
 * одному; здесь они собраны двумя вкладками: «Проекты и чаты» — живые
 * разговоры по проектам, «Вопросы» — всё, что ждёт ответа, по карточке на чат.
 */
export default function HomeScreen() {
  const t = useT();
  const router = useRouter();
  const connection = useConnection();
  const workspace = useWorkspace();
  const configured = isConfigured(connection);
  // Ответ сервера плюс вопросы идущих ходов из их потоков — см. `withLiveAsks`.
  const inbox = useInboxChats(configured);
  const pull = usePullRefresh(inbox.refetch);
  const sent = useSent();
  const [tab, setTab] = useState<HomeTab>('chats');
  const now = useClock();

  const chats = useMemo(() => inbox.data ?? [], [inbox.data]);
  const groups = useMemo(() => projectGroups(chats, sent), [chats, sent]);
  const cards = useMemo(() => questionCards(chats, sent), [chats, sent]);
  const pending = useMemo(() => pendingCount(chats, sent), [chats, sent]);

  // Сервер перестал отдавать отправленный вопрос — ответ дошёл, помнить его незачем.
  // Сверка — с той же сводкой, что на экране: вопрос из потока сервер ещё не
  // отдаёт, и сверка с одним ответом сервера сбросила бы его отметку сразу.
  useEffect(() => {
    if (!inbox.data) return;
    forgetSent(staleSent(inbox.data, sent));
  }, [inbox.data, sent]);

  const open = (chat: InboxChat): void => {
    openChat(localChatKey(chat), chat.projectPath);
    router.push('/chat');
  };

  if (!configured) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Empty text={t.common.notConnectedChat} />
      </SafeAreaView>
    );
  }

  const failed = inbox.isError;
  const loaded = inbox.data !== undefined;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Фоновый наблюдатель панели: виден, только пока включён. */}
      <WatcherChip enabled={configured} />
      <View style={styles.tabs} accessibilityRole="tablist">
        <Segment
          label={t.home.tabChats}
          selected={tab === 'chats'}
          onPress={() => setTab('chats')}
        />
        <Segment
          label={t.home.tabQuestions}
          a11y={t.home.tabQuestionsA11y(pending)}
          badge={pending}
          selected={tab === 'questions'}
          onPress={() => setTab('questions')}
        />
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        {failed && loaded ? <Text style={styles.failed}>{t.home.failed}</Text> : null}
        {failed && !loaded ? (
          <View style={styles.center}>
            <Muted style={styles.centerText}>{t.home.failedEmpty}</Muted>
            <Button title={t.home.retry} onPress={() => void inbox.refetch()} />
          </View>
        ) : null}
        {!loaded && !failed ? <Loading /> : null}

        {loaded && tab === 'chats' ? (
          <>
            <View style={styles.actions}>
              <Button
                title={t.home.newChat}
                tone="accent"
                style={styles.grow}
                onPress={() => {
                  openChat(newChatId(), workspace.projectPath);
                  router.push('/chat');
                }}
              />
              <Button
                title={t.home.allChats}
                style={styles.grow}
                onPress={() => router.push('/chats')}
              />
            </View>
            {groups.length === 0 ? (
              <EmptyState title={t.home.activeEmpty} hint={t.home.activeEmptyHint} />
            ) : (
              <ActiveChats groups={groups} now={now} onOpen={open} />
            )}
          </>
        ) : null}

        {loaded && tab === 'questions' ? (
          <QuestionsTab cards={cards} now={now} onOpen={open} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Вкладка «Вопросы» — карточка на чат или пустое состояние. */
function QuestionsTab({
  cards,
  now,
  onOpen,
}: {
  cards: readonly QuestionCardData[];
  now: number;
  onOpen: (chat: InboxChat) => void;
}) {
  const t = useT();
  if (cards.length === 0) {
    return <EmptyState title={t.home.noQuestions} hint={t.home.noQuestionsHint} />;
  }
  return (
    <>
      {cards.map((card) => (
        <AskCard
          key={stableChatKey(card.chat)}
          chat={card.chat}
          asks={card.asks}
          now={now}
          onOpen={() => onOpen(card.chat)}
        />
      ))}
    </>
  );
}

function Segment({
  label,
  a11y,
  badge = 0,
  selected,
  onPress,
}: {
  label: string;
  a11y?: string;
  badge?: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.segment, selected && styles.segmentOn]}
    >
      <Text style={[styles.segmentText, selected && styles.segmentTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Muted style={styles.centerText}>{hint}</Muted>
    </View>
  );
}

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  grow: { flex: 1 },
  tabs: {
    flexDirection: 'row',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
    padding: 3,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 38,
    paddingHorizontal: space.sm,
    borderRadius: 8,
  },
  segmentOn: { backgroundColor: colors.accentDim },
  segmentText: { color: colors.textDim, fontSize: font.body, fontWeight: '600', flexShrink: 1 },
  segmentTextOn: { color: colors.text },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: colors.waiting,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  content: { padding: space.lg, paddingTop: space.sm, gap: space.md },
  actions: { flexDirection: 'row', gap: space.sm },
  failed: { color: colors.danger, fontSize: font.small },
  center: { paddingVertical: space.xl, alignItems: 'center', gap: space.md },
  centerText: { textAlign: 'center', lineHeight: 18 },
  emptyTitle: { color: colors.text, fontSize: font.title, fontWeight: '600' },
});
