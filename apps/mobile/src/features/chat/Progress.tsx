import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatProgress } from '@claude-control/contracts';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';

/**
 * План агента и его субагенты — то же, что показывает панель, и так же только
 * для чтения: чекпоинты это вызовы TodoWrite из транскрипта, а не наша модель
 * задач. Править их значило бы врать агенту о его же состоянии.
 */
export function Progress({ progress }: { progress: ChatProgress | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!progress) return null;

  const tasks = progress.tasks ?? [];
  const agents = progress.agents ?? [];
  if (tasks.length === 0 && agents.length === 0) return null;

  const done = tasks.filter((task) => task.status === 'completed').length;
  const current = tasks.find((task) => task.status === 'in_progress');

  return (
    <Pressable onPress={() => setOpen((value) => !value)} style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.counter}>{t.chat.plan(done, tasks.length)}</Text>
        <Text style={styles.current} numberOfLines={1}>
          {current?.text ?? (agents.length > 0 ? t.chat.subagents(agents.length) : '')}
        </Text>
      </View>

      {open ? (
        <View style={styles.list}>
          {tasks.map((task, index) => (
            <Text key={index} style={styles.task}>
              {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▸' : '·'}{' '}
              <Text style={task.status === 'completed' ? styles.taskDone : undefined}>
                {task.text}
              </Text>
            </Text>
          ))}
          {agents.map((agent) => (
            <Text key={agent.id} style={styles.agent} numberOfLines={2}>
              {agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✕' : '▸'} {agent.kind}:{' '}
              {agent.description}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  counter: { color: colors.accent, fontSize: font.small, fontWeight: '700' },
  current: { color: colors.textDim, fontSize: font.small, flex: 1 },
  list: { gap: space.xs, paddingTop: space.xs },
  task: { color: colors.text, fontSize: font.small, lineHeight: 18 },
  taskDone: { color: colors.textFaint, textDecorationLine: 'line-through' },
  agent: { color: colors.textDim, fontSize: font.small, fontFamily: font.mono },
  radius: { borderRadius: radius.sm },
});
