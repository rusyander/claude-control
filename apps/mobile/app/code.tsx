import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  Card,
  Empty,
  Icon,
  ListRow,
  Loading,
  Mono,
  Muted,
  Row,
  Screen,
  Title,
} from '../src/shared/ui';
import { colors, font, space, tabular } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useWorkspace } from '../src/shared/lib/workspace';
import { useFileTree } from '../src/entities/files/api';
import { FileView } from '../src/features/code/FileView';
import { useFileChanges } from '../src/entities/files/useFileChanges';

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

          <View>
            {(tree.data?.entries ?? []).map((entry, index) => (
              <ListRow
                key={entry.path}
                title={entry.name}
                divided={index > 0}
                leading={
                  <Icon
                    ios={entry.isDir ? 'folder' : 'doc'}
                    android={entry.isDir ? 'folder' : 'description'}
                    size={20}
                    color={entry.isDir ? colors.accent : colors.textFaint}
                  />
                }
                trailing={
                  entry.sizeBytes !== undefined ? (
                    <Text style={styles.size}>
                      {Math.max(1, Math.round(entry.sizeBytes / 1024))} {t.common.kb}
                    </Text>
                  ) : undefined
                }
                onPress={() => (entry.isDir ? setDir(entry.path) : setFile(entry.path))}
              />
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
  name: { color: colors.text, fontSize: font.body, flex: 1 },
  size: { color: colors.textFaint, fontSize: font.small, ...tabular },
  added: { color: colors.success },
  removed: { color: colors.danger },
  warn: { color: colors.warning },
});
