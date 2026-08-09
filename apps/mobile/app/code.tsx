import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Card, Empty, Loading, Mono, Muted, Row, Screen, Title } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useWorkspace } from '../src/shared/lib/workspace';
import { useFileChanges, useFileTree } from '../src/entities/files/api';
import { FileView } from '../src/features/code/FileView';

/**
 * Среда разработки глазами телефона: дерево проекта, список тронутого агентом и
 * сам файл — всё только на чтение.
 *
 * Дерево грузится по каталогу, а не целиком: у проекта бывают десятки тысяч
 * файлов, и одна выдача на всё дерево положила бы и сервер, и экран.
 */
export default function CodeScreen() {
  const t = useT();
  const workspace = useWorkspace();
  const [dir, setDir] = useState('');
  const [file, setFile] = useState('');

  const projectPath = workspace.projectPath;
  const tree = useFileTree(projectPath, dir);
  const changes = useFileChanges(projectPath, workspace.chatId);

  if (!projectPath) {
    return (
      <>
        <Stack.Screen options={{ title: t.code.title }} />
        <Empty text={t.code.noProject} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t.code.title }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={tree.isFetching || changes.isFetching}
            onRefresh={() => {
              void tree.refetch();
              void changes.refetch();
            }}
            tintColor={colors.accent}
          />
        }
      >
        {/* Открытый файл идёт первым: дерево тут в два десятка строк, и файл под
            ним пришлось бы каждый раз пролистывать. */}
        {file ? (
          <Card>
            <FileView
              projectPath={projectPath}
              file={file}
              chatId={workspace.chatId}
              onClose={() => setFile('')}
            />
          </Card>
        ) : null}

        {changes.data && changes.data.files.length > 0 ? (
          <Card>
            <Title>{t.code.changedHere}</Title>
            {changes.data.files.map((change) => (
              <Pressable key={change.path} onPress={() => setFile(change.path)}>
                <Row gap={space.sm}>
                  <Text style={styles.name} numberOfLines={1}>
                    {change.path}
                  </Text>
                  <Mono style={styles.added}>+{change.added}</Mono>
                  <Mono style={styles.removed}>−{change.removed}</Mono>
                  {change.missing ? <Mono style={styles.warn}>{t.code.missing}</Mono> : null}
                </Row>
              </Pressable>
            ))}
            {changes.data.skipped > 0 ? (
              <Muted>{t.code.unbound(changes.data.skipped)}</Muted>
            ) : null}
          </Card>
        ) : null}

        <Card>
          <Row gap={space.sm}>
            <Title style={styles.grow} numberOfLines={1}>
              {dir || t.code.root}
            </Title>
            {dir ? (
              <Pressable onPress={() => setDir(parentOf(dir))}>
                <Muted>{t.common.up}</Muted>
              </Pressable>
            ) : null}
          </Row>

          {tree.isLoading ? <Loading /> : null}
          {tree.isError ? <Mono style={styles.warn}>{t.code.dirFailed}</Mono> : null}

          <View style={styles.list}>
            {(tree.data?.entries ?? []).map((entry) => (
              <Pressable
                key={entry.path}
                onPress={() => (entry.isDir ? setDir(entry.path) : setFile(entry.path))}
              >
                <Row gap={space.sm}>
                  <Text style={styles.name} numberOfLines={1}>
                    {entry.isDir ? '📁 ' : '📄 '}
                    {entry.name}
                  </Text>
                  {entry.sizeBytes !== undefined ? (
                    <Mono>
                      {Math.max(1, Math.round(entry.sizeBytes / 1024))} {t.common.kb}
                    </Mono>
                  ) : null}
                </Row>
              </Pressable>
            ))}
          </View>
          {tree.data?.truncated ? <Muted>{t.code.partial}</Muted> : null}
        </Card>
      </Screen>
    </>
  );
}

/** Путь на уровень выше; разделитель дерева всегда `/`, даже на Windows. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  list: { gap: space.xs, paddingTop: space.xs },
  name: { color: colors.text, fontSize: font.body, flex: 1 },
  added: { color: colors.success },
  removed: { color: colors.danger },
  warn: { color: colors.warning },
});
