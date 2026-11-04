import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { Card, ListRow, Loading, Muted, Screen } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useCoreTasks } from '../src/entities/core-task';

/**
 * Задачи ядра (этап 10, зона D): живые сверху, у каждой — состояние и «нужен человек». Нажатие —
 * экран задачи с открытыми вопросами (`core-task.tsx`), туда же ведёт push о вопросе ядра.
 */
export default function CoreTasksScreen() {
  const t = useT();
  const tasks = useCoreTasks();
  const list = [...(tasks.data?.tasks ?? [])].sort((a, b) => Number(b.live) - Number(a.live));

  return (
    <>
      <Stack.Screen options={{ title: t.coreTask.listTitle }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={tasks.isFetching}
            onRefresh={() => void tasks.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        {tasks.isLoading ? <Loading /> : null}
        {tasks.error ? (
          <Card>
            <Text style={styles.bad}>{(tasks.error as Error).message}</Text>
          </Card>
        ) : null}
        {!tasks.isLoading && !tasks.error && list.length === 0 ? (
          <Card>
            <Muted>{t.coreTask.empty}</Muted>
          </Card>
        ) : null}
        <View style={styles.list}>
          {list.map((task, index) => (
            <ListRow
              key={task.taskId}
              divided={index > 0}
              title={task.title?.trim() || t.coreTask.untitled}
              subtitle={[
                task.live ? t.coreTask.live : t.coreTask.ended,
                task.state,
                task.attention ? t.coreTask.attention : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              onPress={() => router.push({ pathname: '/core-task', params: { id: task.taskId } })}
            />
          ))}
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  bad: { color: colors.danger, fontSize: font.small },
});
