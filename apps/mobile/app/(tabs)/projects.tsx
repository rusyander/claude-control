import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Empty, Field, Icon, Loading, Mono, Muted, Screen, Segmented } from '../../src/shared/ui';
import { colors, font, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { useConnection, isConfigured } from '../../src/shared/api/connection';
import { useWorkspace, openChat, openProject } from '../../src/shared/lib/workspace';
import { useNow } from '../../src/shared/lib/useNow';
import { useChatProjects } from '../../src/entities/chat/useChatProjects';
import { useProjectRegistry } from '../../src/entities/project/useProjectRegistry';
import { useAddProject } from '../../src/entities/project/useAddProject';
import { buildProjectLists, matchesQuery, pathKey } from '../../src/entities/project/projectList';
import type { ProjectEntry } from '../../src/entities/project/projectList.types';
import { useInboxChats } from '../../src/features/inbox/useInboxChats';
import { projectLive } from '../../src/features/projects/projectLive';
import { ProjectCard } from '../../src/features/projects/ProjectCard/ProjectCard';
import { FolderBrowser } from '../../src/features/projects/FolderBrowser/FolderBrowser';

type ProjectsTab = 'projects' | 'folders';

/** Поиск появляется, когда проектов больше, чем помещается на экран. */
const SEARCH_FROM = 6;

/**
 * Проекты: тот же список, что в разделе «Проекты» панели на компьютере, и из
 * каждого — в один тап в чат: «+» начинает новый, «Продолжить» открывает
 * последний. Экран проекта (нажатие на карточку) — все чаты, git и копии.
 *
 * Вторая вкладка — обзор папок машины: начать чат в любой папке или добавить
 * её в проекты. Папки из истории чатов вне реестра собраны внизу свёрнутым
 * блоком: в истории каждая временная папка, где хоть раз запускался агент, и
 * наверху списка они только мешали бы найти свой проект.
 */
export default function ProjectsScreen() {
  const t = useT();
  const router = useRouter();
  const connection = useConnection();
  const configured = isConfigured(connection);
  const workspace = useWorkspace();
  const now = useNow();
  const [tab, setTab] = useState<ProjectsTab>('projects');
  const [query, setQuery] = useState('');
  const [showOthers, setShowOthers] = useState(false);
  const [dir, setDir] = useState('');

  const registry = useProjectRegistry();
  const history = useChatProjects();
  const inbox = useInboxChats(configured);
  const add = useAddProject();

  const lists = useMemo(
    () => buildProjectLists(registry.data ?? [], history.data ?? []),
    [registry.data, history.data],
  );
  const live = useMemo(() => projectLive(inbox.data ?? []), [inbox.data]);
  const registeredKeys = useMemo(
    () => new Set((registry.data ?? []).map((project) => pathKey(project.path))),
    [registry.data],
  );

  if (!configured) {
    return <Empty text={t.common.notConnected} />;
  }

  const currentKey = workspace.projectPath ? pathKey(workspace.projectPath) : '';
  const mine = lists.mine.filter((entry) => matchesQuery(entry, query));
  const others = lists.others.filter((entry) => matchesQuery(entry, query));

  const newChat = (path: string): void => {
    openProject(path);
    router.push('/chat');
  };
  const card = (entry: ProjectEntry) => (
    <ProjectCard
      key={entry.path}
      entry={entry}
      current={pathKey(entry.path) === currentKey}
      live={live.get(pathKey(entry.path))}
      now={now}
      onOpen={() =>
        router.push({ pathname: '/project', params: { path: entry.path, name: entry.name } })
      }
      onNewChat={() => newChat(entry.path)}
      onContinue={(chat) => {
        openChat(chat.id, chat.path);
        router.push('/chat');
      }}
      onAdd={entry.registered ? undefined : () => add.mutate(entry.path)}
      adding={add.isPending && add.variables === entry.path}
    />
  );

  const refresh = (): void => {
    void registry.refetch();
    void history.refetch();
  };
  const loading = registry.isLoading || history.isLoading;
  const failed = registry.error ?? history.error;

  return (
    <Screen
      scroll
      header={
        <Segmented<ProjectsTab>
          options={[
            { value: 'projects', label: t.projects.tabProjects },
            { value: 'folders', label: t.projects.tabFolders },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
      refreshControl={
        <RefreshControl
          refreshing={registry.isRefetching || history.isRefetching}
          onRefresh={refresh}
          tintColor={colors.accent}
        />
      }
    >
      {tab === 'folders' ? (
        <FolderBrowser
          dir={dir}
          onDir={setDir}
          registered={(path) => registeredKeys.has(pathKey(path))}
          onNewChat={newChat}
        />
      ) : (
        <>
          {lists.mine.length + lists.others.length > SEARCH_FROM ? (
            <Field value={query} onChangeText={setQuery} placeholder={t.projects.search} />
          ) : null}
          {loading ? <Loading /> : null}
          {failed ? <Mono style={styles.failed}>{failed.message}</Mono> : null}
          {add.error ? <Mono style={styles.failed}>{add.error.message}</Mono> : null}

          {!loading && lists.mine.length === 0 ? (
            <Empty
              title={t.projects.emptyTitle}
              text={t.projects.emptyText}
              icon={<Icon ios="folder" android="folder" size={28} color={colors.accent} />}
            />
          ) : null}
          {query && mine.length === 0 && others.length === 0 ? (
            <Muted style={styles.center}>{t.projects.nothingFound}</Muted>
          ) : null}

          {mine.map(card)}

          {others.length > 0 ? (
            <View style={styles.others}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showOthers || Boolean(query) }}
                onPress={() => setShowOthers((open) => !open)}
                style={({ pressed }) => [styles.othersHead, pressed && styles.pressed]}
              >
                <Text style={styles.othersTitle}>{t.projects.others(others.length)}</Text>
                <Icon
                  ios={showOthers ? 'chevron.up' : 'chevron.down'}
                  android={showOthers ? 'expand_less' : 'expand_more'}
                  size={18}
                  color={colors.textDim}
                />
              </Pressable>
              {/* Поиск раскрывает блок сам: найденное не должно прятаться за свёрткой. */}
              {showOthers || query ? (
                <>
                  <Muted>{t.projects.othersHint}</Muted>
                  {others.map(card)}
                </>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  failed: { color: colors.danger },
  center: { textAlign: 'center' },
  pressed: { opacity: 0.7 },
  others: { gap: space.md, marginTop: space.sm },
  othersHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.xs,
  },
  othersTitle: { color: colors.textDim, fontSize: font.small + 1, fontWeight: '700' },
});
