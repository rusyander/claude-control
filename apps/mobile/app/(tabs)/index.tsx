import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Button, Chips, Empty, Icon, Loading, Segmented } from '../../src/shared/ui';
import { colors, font, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { useConnection, isConfigured } from '../../src/shared/api/connection';
import { useWorkspace, newChatId, openChat } from '../../src/shared/lib/workspace';
import { panelTitle } from '../../src/shared/api/panels';
import { activatePanel } from '../../src/shared/lib/panel-switch';
import { usePullRefresh } from '../../src/shared/lib/pull-refresh';
import { useNow } from '../../src/shared/lib/useNow';
import { baseName } from '../../src/entities/project/projectList';
import { projectGroups } from '../../src/entities/inbox/model';
import { ActiveChats } from '../../src/features/inbox/ActiveChats/ActiveChats';
import { Pulse } from '../../src/features/inbox/Pulse/Pulse';
import { AskCard } from '../../src/features/inbox/AskCard/AskCard';
import { localChatKey } from '../../src/features/inbox/chatKey';
import { useSent, forgetSent } from '../../src/features/inbox/sent';
import { useInboxChats } from '../../src/features/inbox/useInboxChats';
import { WatcherChip } from '../../src/features/watcher/WatcherChip';
import { LimitsStrip } from '../../src/features/usage-limits/LimitsStrip/LimitsStrip';
import { stableChatKey } from '../../src/entities/inbox/stableChatKey';
import { pendingCount } from '../../src/entities/inbox/pendingCount';
import { staleSent } from '../../src/entities/inbox/staleSent';
import type { QuestionCardData } from '../../src/entities/inbox/questionCards';
import { questionCards } from '../../src/entities/inbox/questionCards';

type HomeTab = 'chats' | 'questions';

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
  const now = useNow();

  const chats = useMemo(() => inbox.data ?? [], [inbox.data]);
  const groups = useMemo(() => projectGroups(chats, sent), [chats, sent]);
  const cards = useMemo(() => questionCards(chats, sent), [chats, sent]);
  const pending = useMemo(() => pendingCount(chats, sent), [chats, sent]);
  const running = groups.reduce((sum, group) => sum + group.running, 0);
  const projects = groups.filter((group) => !group.isSandbox).length;

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
      {/* Спарен с несколькими компьютерами — выбор прямо здесь: главная показывает
          работу одного из них, и надо видеть, какого. */}
      {connection.panels.length > 1 ? (
        <View style={styles.computers}>
          <Chips
            scroll
            options={connection.panels.map((entry) => ({
              value: entry.id,
              label: panelTitle(entry),
            }))}
            value={connection.activeId}
            onChange={(id) => void activatePanel(id)}
          />
        </View>
      ) : null}
      {/* Лимиты подписки выбранного компьютера — над вкладками, видны в обеих. */}
      <View style={styles.limits}>
        <LimitsStrip />
      </View>
      <View style={styles.tabs}>
        <Segmented<HomeTab>
          options={[
            { value: 'chats', label: t.home.tabChats },
            {
              value: 'questions',
              label: t.home.tabQuestions,
              a11y: t.home.tabQuestionsA11y(pending),
              badge: pending,
            },
          ]}
          value={tab}
          onChange={setTab}
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
          <Empty
            text={t.home.failedEmpty}
            icon={<Icon ios="wifi.slash" android="cloud_off" size={28} color={colors.danger} />}
          >
            <Button title={t.home.retry} onPress={() => void inbox.refetch()} />
          </Empty>
        ) : null}
        {!loaded && !failed ? <Loading /> : null}

        {loaded && tab === 'chats' ? (
          <>
            <Pulse
              running={running}
              waiting={pending}
              projects={projects}
              onWaiting={() => setTab('questions')}
            />
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
            <Pressable
              accessibilityRole="button"
              onPress={() => router.navigate('/projects')}
              style={({ pressed }) => [styles.where, pressed && styles.pressed]}
            >
              <Icon ios="folder" android="folder" size={14} color={colors.textDim} />
              <Text style={styles.whereText} numberOfLines={1}>
                {workspace.projectPath
                  ? t.home.newChatWhere(baseName(workspace.projectPath))
                  : t.home.newChatNoProject}
              </Text>
              <Text style={styles.whereLink}>{t.home.changeProject}</Text>
            </Pressable>
            {groups.length === 0 ? (
              <Empty
                title={t.home.activeEmpty}
                text={t.home.activeEmptyHint}
                icon={<Icon ios="bubble.left.and.bubble.right" android="forum" size={28} />}
              />
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
    return (
      <Empty
        title={t.home.noQuestions}
        text={t.home.noQuestionsHint}
        icon={
          <Icon ios="checkmark.bubble" android="mark_chat_read" size={28} color={colors.success} />
        }
      />
    );
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  grow: { flex: 1 },
  tabs: { marginHorizontal: space.lg, marginTop: space.sm, marginBottom: space.xs },
  computers: { marginHorizontal: space.lg, marginTop: space.sm },
  limits: { marginHorizontal: space.lg, marginTop: space.sm },
  content: { padding: space.lg, paddingTop: space.sm, gap: space.md },
  actions: { flexDirection: 'row', gap: space.sm },
  failed: { color: colors.danger, fontSize: font.small },
  pressed: { opacity: 0.7 },
  where: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, marginTop: -space.xs },
  whereText: { flexShrink: 1, color: colors.textDim, fontSize: font.small },
  whereLink: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
});
