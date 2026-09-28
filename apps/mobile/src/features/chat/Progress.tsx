import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatProgress } from '@agentdeck/contracts';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { progressHead } from './progressView';

/**
 * План агента и его субагенты — то же, что показывает панель, и так же только
 * для чтения: чекпоинты это вызовы TodoWrite из транскрипта, а не наша модель
 * задач. Править их значило бы врать агенту о его же состоянии.
 */
export function Progress({
  progress,
  isRunning = false,
}: {
  progress: ChatProgress | undefined;
  /** Идёт ли прогон: субагенты и текущий вызов живы только у идущего. */
  isRunning?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!progress) return null;

  const tasks = progress.tasks ?? [];
  const agents = progress.agents ?? [];
  const head = progressHead(progress, isRunning);
  if (tasks.length === 0 && agents.length === 0 && !head.activeTool) return null;

  return (
    <Pressable onPress={() => setOpen((value) => !value)} style={styles.root}>
      <View style={styles.head}>
        {head.total > 0 ? (
          <Text style={styles.counter}>{t.chat.plan(head.done, head.total)}</Text>
        ) : null}
        <Text style={styles.current} numberOfLines={1}>
          {head.current ?? (agents.length > 0 ? t.chat.subagents(head.running, head.finished) : '')}
        </Text>
      </View>
      {head.current && agents.length > 0 ? (
        <Text style={styles.current} numberOfLines={1}>
          {t.chat.subagents(head.running, head.finished)}
        </Text>
      ) : null}
      {head.activeTool ? (
        <Text style={styles.current} numberOfLines={1} testID="active-tool">
          {t.chat.activeTool(head.activeTool.name, head.activeTool.summary)}
        </Text>
      ) : null}

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
              {agentMark(agent.status, isRunning)} {agent.kind}: {agent.description}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Значок субагента: «идёт» только у идущего прогона — оборванный не работает. */
function agentMark(status: string, isRunning: boolean): string {
  if (status === 'done') return '✓';
  if (status === 'failed') return '✕';
  return isRunning ? '▸' : '·';
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
