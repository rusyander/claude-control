import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Button,
  Card,
  Empty,
  Icon,
  Loading,
  Muted,
  Row,
  Screen,
  Segmented,
  StatusDot,
} from '../src/shared/ui';
import { colors, font, space, tabular } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useConnection, isConfigured } from '../src/shared/api/connection';
import { useWorkspace, newChatId, openChat, openProject } from '../src/shared/lib/workspace';
import { useNow } from '../src/shared/lib/useNow';
import { useChatProjects } from '../src/entities/chat/useChatProjects';
import { useProjectRegistry } from '../src/entities/project/useProjectRegistry';
import { ageMinutes } from '../src/entities/inbox/ageMinutes';
import { baseName, buildProjectLists, pathKey } from '../src/entities/project/projectList';
import type { ProjectChatEntry } from '../src/entities/project/projectList.types';
import { useInboxChats } from '../src/features/inbox/useInboxChats';
import { chatStatus, projectLive } from '../src/features/projects/projectLive';
import { ProjectTile } from '../src/features/projects/ProjectTile/ProjectTile';
import { LivePills } from '../src/features/projects/LivePills/LivePills';
import { GitPanel } from '../src/features/git/GitPanel/GitPanel';
import { Worktrees } from '../src/features/git/Worktrees/Worktrees';
import { ForeignChatsSection } from '../src/features/chat/foreign/ForeignChatsSection/ForeignChatsSection';

type ProjectTab = 'chats' | 'git' | 'copies';

/** Столько чатов сразу; остальные — по кнопке: у живого проекта их десятки. */
const FIRST_CHATS = 20;

/**
 * Экран проекта: все его чаты (вместе с чатами в копиях веток), git и копии.
 * Чаты — первая вкладка, потому что за ними сюда и приходят; git и копии —
 * рядом, но не на пути к разговору.
 */
export default function ProjectScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string; name?: string }>();
  const path = params.path ?? '';
  const configured = isConfigured(useConnection());
  const workspace = useWorkspace();
  const now = useNow();
  const [tab, setTab] = useState<ProjectTab>('chats');
  const [all, setAll] = useState(false);

  const registry = useProjectRegistry();
  const history = useChatProjects();
  const inbox = useInboxChats(configured);

  const entry = useMemo(() => {
    const lists = buildProjectLists(registry.data ?? [], history.data ?? []);
    const key = pathKey(path);
    return [...lists.mine, ...lists.others].find((item) => pathKey(item.path) === key);
  }, [registry.data, history.data, path]);
  const live = useMemo(() => projectLive(inbox.data ?? []).get(pathKey(path)), [inbox.data, path]);

  const name = entry?.name ?? params.name ?? baseName(path);
  const chats = entry?.chats ?? [];
  const shown = all ? chats : chats.slice(0, FIRST_CHATS);

  const open = (chat: ProjectChatEntry): void => {
    openChat(chat.id, chat.path);
    router.push('/chat');
  };
  const inProject = (route: '/code' | '/tests'): void => {
    // Код и тесты показывают проект рабочего места; чужой проект делаем текущим,
    // а открытый в этом проекте разговор не сбрасываем.
    if (pathKey(workspace.projectPath) !== pathKey(path)) openProject(path);
    router.push(route);
  };

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <Screen
        scroll
        header={
          <>
            <View style={styles.hero}>
              <ProjectTile name={name} size={36} />
              <View style={styles.heroBody}>
                <Text style={styles.heroPath} numberOfLines={2}>
                  {path}
                </Text>
                <View style={styles.pills}>
                  <LivePills live={live} />
                </View>
              </View>
            </View>
            <Row gap={space.sm}>
              <Button
                title={t.projects.newChat}
                tone="accent"
                style={styles.grow}
                onPress={() => {
                  openChat(newChatId(), path);
                  router.push('/chat');
                }}
              />
              <Button
                title={t.projects.code}
                style={styles.grow}
                onPress={() => inProject('/code')}
              />
              <Button
                title={t.projects.tests}
                style={styles.grow}
                onPress={() => inProject('/tests')}
              />
            </Row>
            <Segmented<ProjectTab>
              options={[
                {
                  value: 'chats',
                  label:
                    chats.length > 0
                      ? `${t.projects.tabChats} · ${chats.length}`
                      : t.projects.tabChats,
                },
                { value: 'git', label: t.projects.tabGit },
                { value: 'copies', label: t.projects.tabCopies },
              ]}
              value={tab}
              onChange={setTab}
            />
          </>
        }
        refreshControl={
          <RefreshControl
            refreshing={history.isRefetching}
            onRefresh={() => void history.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        {tab === 'chats' ? (
          <>
            {history.isLoading ? <Loading /> : null}
            {!history.isLoading && chats.length === 0 ? (
              <Empty
                text={t.projects.chatsEmpty}
                icon={<Icon ios="bubble.left.and.bubble.right" android="forum" size={28} />}
              />
            ) : null}
            {shown.length > 0 ? (
              <Card style={styles.list}>
                {shown.map((chat, index) => (
                  <ChatLine
                    key={chat.id}
                    chat={chat}
                    status={chatStatus(inbox.data ?? [], chat.id)}
                    now={now}
                    first={index === 0}
                    current={chat.id === workspace.chatId}
                    onPress={() => open(chat)}
                  />
                ))}
              </Card>
            ) : null}
            {!all && chats.length > FIRST_CHATS ? (
              <Button title={t.projects.showAll(chats.length)} onPress={() => setAll(true)} />
            ) : null}
            <ForeignChatsSection projectPath={path} />
          </>
        ) : null}
        {tab === 'git' ? <GitPanel projectPath={path} /> : null}
        {tab === 'copies' ? <Worktrees projectPath={path} /> : null}
      </Screen>
    </>
  );
}

/** Строка чата: статус, название, свежесть; ниже — число сообщений и копия ветки. */
function ChatLine({
  chat,
  status,
  now,
  first,
  current,
  onPress,
}: {
  chat: ProjectChatEntry;
  status: string | undefined;
  now: number;
  first: boolean;
  current: boolean;
  onPress: () => void;
}) {
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chat.title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.line,
        !first && styles.lineDivided,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.dot}>
        <StatusDot status={status ?? 'idle'} />
      </View>
      <View style={styles.lineBody}>
        <Row gap={space.sm}>
          <Text style={[styles.lineTitle, current && styles.lineCurrent]} numberOfLines={1}>
            {chat.title}
          </Text>
          <Text style={styles.age}>{t.home.age(ageMinutes(chat.updatedAt, now))}</Text>
        </Row>
        <Row gap={space.sm}>
          <Muted>
            {chat.messageCountPartial ? '+' : ''}
            {t.chats.messages(chat.messageCount)}
          </Muted>
          {chat.copy ? (
            <View style={styles.copy}>
              <Icon
                ios="arrow.triangle.branch"
                android="call_split"
                size={11}
                color={colors.textDim}
              />
              <Text style={styles.copyText} numberOfLines={1}>
                {chat.copy}
              </Text>
            </View>
          ) : null}
        </Row>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroBody: { flex: 1, gap: 2 },
  heroPath: { color: colors.textFaint, fontSize: font.small },
  pills: { flexDirection: 'row', gap: space.xs },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  lineDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  dot: { paddingTop: 6 },
  lineBody: { flex: 1, gap: 2 },
  lineTitle: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  lineCurrent: { color: colors.accent },
  age: { color: colors.textFaint, fontSize: font.small, ...tabular },
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 1,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copyText: { color: colors.textDim, fontSize: 11, flexShrink: 1 },
});
