import { Pressable, Text, View } from 'react-native';
import { Button, Card, Icon, ListRow, Loading, Mono, Muted, Row } from '../../../shared/ui';
import { colors } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { useFsRoots } from '../../../entities/project/api';
import { useFsList } from '../../../entities/project/useFsList';
import { useAddProject } from '../../../entities/project/useAddProject';
import { styles } from './FolderBrowser.styles';

/**
 * Обзор файловой системы машины с панелью: зайти в любую папку и начать в ней
 * чат или добавить её в проекты панели. Проект здесь — просто путь: агент
 * может работать в любой папке, и «сначала заведи проект» не требуется.
 */
export function FolderBrowser({
  dir,
  onDir,
  registered,
  onNewChat,
}: {
  dir: string;
  onDir: (dir: string) => void;
  /** Есть ли папка в реестре панели — тогда кнопки «Добавить» нет. */
  registered: (path: string) => boolean;
  onNewChat: (path: string) => void;
}) {
  const t = useT();
  const roots = useFsRoots();
  const listing = useFsList(dir);
  const add = useAddProject();

  const entries = dir ? (listing.data?.entries ?? []) : (roots.data ?? []);
  // Панель может быть просто выключена. Тогда «Пусто» — враньё: диск не пуст,
  // до него не дошёл запрос, и сказать надо именно это.
  const offline = dir ? listing.error : roots.error;
  const loading = dir ? listing.isLoading : roots.isLoading;
  const parent = listing.data?.parent;

  return (
    <>
      {dir ? (
        <Card>
          <Row gap={8}>
            <Icon ios="folder.fill" android="folder" size={20} color={colors.accent} />
            <Mono numberOfLines={2} style={styles.grow}>
              {dir}
            </Mono>
          </Row>
          <Row gap={8}>
            <Button
              title={t.projects.newChatHere}
              tone="accent"
              onPress={() => onNewChat(dir)}
              style={styles.grow}
            />
            {registered(dir) ? null : (
              <Button
                title={t.projects.addHere}
                onPress={() => add.mutate(dir)}
                busy={add.isPending}
                style={styles.grow}
              />
            )}
          </Row>
          {add.error ? <Mono style={styles.failed}>{add.error.message}</Mono> : null}
        </Card>
      ) : null}

      <Card>
        <Row gap={8}>
          <Text style={styles.heading}>{dir ? t.projects.tabFolders : t.projects.disks}</Text>
          {dir ? (
            <Row gap={16}>
              {parent ? (
                <Pressable accessibilityRole="button" onPress={() => onDir(parent)} hitSlop={8}>
                  <Text style={styles.link}>{t.common.up}</Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" onPress={() => onDir('')} hitSlop={8}>
                <Text style={styles.link}>{t.projects.toDisks}</Text>
              </Pressable>
            </Row>
          ) : null}
        </Row>

        {loading ? <Loading /> : null}
        {offline ? <Mono style={styles.failed}>{offline.message}</Mono> : null}

        <View>
          {entries.map((entry, index) => (
            <ListRow
              key={entry.path}
              title={entry.name}
              subtitle={registered(entry.path) ? t.projects.inProjects : undefined}
              divided={index > 0}
              leading={
                <Icon
                  ios={entry.isFile ? 'doc' : 'folder'}
                  android={entry.isFile ? 'description' : 'folder'}
                  size={20}
                  color={entry.isFile ? colors.textFaint : colors.accent}
                />
              }
              onPress={entry.isFile ? undefined : () => onDir(entry.path)}
            />
          ))}
        </View>

        {!loading && !offline && entries.length === 0 ? <Muted>{t.common.empty}</Muted> : null}
      </Card>
    </>
  );
}
