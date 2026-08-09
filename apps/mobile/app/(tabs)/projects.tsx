import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Empty, Loading, Mono, Muted, Row, Screen, Title } from '../../src/shared/ui';
import { colors, font, radius, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { isConfigured, useConnection } from '../../src/shared/api/connection';
import { openProject, useWorkspace } from '../../src/shared/lib/workspace';
import { useFsList, useFsRoots } from '../../src/entities/project/api';
import { useChatProjects } from '../../src/entities/chat/api';
import { GitPanel } from '../../src/features/git/GitPanel';

/**
 * Выбор проекта: недавние — и обзор файловой системы машины, где стоит панель.
 *
 * Проект здесь просто путь: реестра приложение не спрашивает, потому что
 * работать агент может в любой папке, и требовать «сначала заведи проект»
 * означало бы упереться в экран, которого в приложении нет.
 */
export default function ProjectsScreen() {
  const t = useT();
  const router = useRouter();
  const connection = useConnection();
  const workspace = useWorkspace();
  const [dir, setDir] = useState('');

  const roots = useFsRoots();
  const listing = useFsList(dir);
  const recent = useChatProjects();

  if (!isConfigured(connection)) {
    return <Empty text={t.common.notConnected} />;
  }

  const open = (path: string): void => {
    openProject(path);
    router.push('/');
  };

  const entries = dir ? (listing.data?.entries ?? []) : (roots.data ?? []);
  // Обзор и недавние приходят разными запросами, но для человека это один экран:
  // потянул — обновилось всё, что на нём есть.
  const refresh = (): void => {
    void (dir ? listing.refetch() : roots.refetch());
    void recent.refetch();
  };
  // Панель может быть просто выключена. Тогда «Пусто» — вранье: диск не пуст,
  // до него не дошёл запрос, и сказать надо именно это.
  const offline = dir ? listing.error : roots.error;

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={listing.isFetching || roots.isFetching || recent.isFetching}
          onRefresh={refresh}
          tintColor={colors.accent}
        />
      }
    >
      {workspace.projectPath ? (
        <Card>
          <Title numberOfLines={1}>{basename(workspace.projectPath)}</Title>
          <Mono numberOfLines={2}>{workspace.projectPath}</Mono>
          <Row gap={space.sm}>
            <Button
              title={t.projects.toChat}
              onPress={() => router.push('/')}
              style={styles.grow}
            />
            <Button
              title={t.projects.code}
              onPress={() => router.push('/code')}
              style={styles.grow}
            />
          </Row>
        </Card>
      ) : null}

      {workspace.projectPath ? <GitPanel projectPath={workspace.projectPath} /> : null}

      {recent.data && recent.data.length > 0 ? (
        <Card>
          <Title>{t.projects.recent}</Title>
          {recent.data.slice(0, 8).map((project) => (
            <Pressable key={project.path} onPress={() => open(project.path)} style={styles.recent}>
              <Text style={styles.name} numberOfLines={1}>
                {project.name}
              </Text>
              <Muted>
                {t.projects.chats(project.chats.length)} ·{' '}
                {project.exists ? project.path : t.projects.gone}
              </Muted>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <Card>
        <Row gap={space.sm}>
          <Title style={styles.grow}>{t.projects.browse}</Title>
          {dir ? (
            <Pressable onPress={() => setDir('')}>
              <Muted>{t.projects.toDisks}</Muted>
            </Pressable>
          ) : null}
        </Row>

        {dir ? (
          <>
            <Mono numberOfLines={2}>{dir}</Mono>
            <Row gap={space.sm}>
              <Button
                title={t.projects.openFolder}
                tone="accent"
                onPress={() => open(dir)}
                style={styles.grow}
              />
              {listing.data?.parent ? (
                <Button title={t.common.up} onPress={() => setDir(listing.data.parent ?? '')} />
              ) : null}
            </Row>
          </>
        ) : null}

        {listing.isLoading || roots.isLoading ? <Loading /> : null}
        {offline ? <Mono style={styles.failed}>{offline.message}</Mono> : null}

        <View style={styles.list}>
          {entries.map((entry) => (
            <Row key={entry.path} gap={space.sm}>
              <Pressable
                onPress={() => (entry.isFile ? undefined : setDir(entry.path))}
                style={styles.grow}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {entry.isFile ? '' : '📁 '}
                  {entry.name}
                </Text>
              </Pressable>
              {entry.isFile ? null : (
                <Pressable onPress={() => open(entry.path)} style={styles.pick}>
                  <Text style={styles.pickText}>{t.common.open}</Text>
                </Pressable>
              )}
            </Row>
          ))}
        </View>

        {!listing.isLoading && !offline && entries.length === 0 ? (
          <Muted>{t.common.empty}</Muted>
        ) : null}
      </Card>
    </Screen>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  list: { gap: space.sm, paddingTop: space.xs },
  name: { color: colors.text, fontSize: font.body },
  recent: { paddingVertical: space.xs, gap: 2 },
  pick: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickText: { color: colors.accent, fontSize: font.small },
  failed: { color: colors.danger },
});
