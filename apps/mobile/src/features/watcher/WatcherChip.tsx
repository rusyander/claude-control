import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Mono, Muted } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { useCostUnit } from '../../entities/settings/api';
import { useTurnOffWatcher, useWatcherStatus } from '../../entities/watcher/api';
import {
  formatUptime,
  watcherElapsedMs,
  watcherSpendText,
  watcherVisible,
} from '../../entities/watcher/model';

/**
 * Значок фонового наблюдателя на главной: виден, только пока он включён, —
 * человек с телефоном должен знать, что в фоне что-то работает и тратит.
 * Нажатие открывает сводку снизу; выключить можно отсюда, включить — в панели.
 */
export function WatcherChip({ enabled }: { enabled: boolean }) {
  const t = useT();
  const query = useWatcherStatus(enabled);
  const status = query.data;
  const visible = watcherVisible(status);
  const now = useTicking(visible);
  const [open, setOpen] = useState(false);
  const unit = useCostUnit();
  const turnOff = useTurnOffWatcher();

  // Выключили (здесь или в панели) — окну сводки показывать больше нечего.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  if (!visible) return null;
  const time = formatUptime(watcherElapsedMs(status, query.dataUpdatedAt, now), t.watcher.duration);
  const state = status.problem
    ? t.watcher.stateProblem
    : status.analyzing
      ? t.watcher.stateAnalyzing
      : '';
  const spend = watcherSpendText(status.spend, unit);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.watcher.chipA11y(time, state)}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.dot,
            status.analyzing && styles.dotBusy,
            status.problem && styles.dotProblem,
          ]}
        />
        <Text style={styles.chipText}>{t.watcher.chip(time)}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel={t.watcher.close}
          onPress={() => setOpen(false)}
        />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <Text style={styles.title} accessibilityRole="header">
            {t.watcher.title}
          </Text>
          <Text style={styles.line}>
            {status.analyzing
              ? `${t.watcher.running(time)} · ${t.watcher.analyzing}`
              : t.watcher.running(time)}
          </Text>
          <Text style={styles.line}>{t.watcher.findings(status.findings, status.remarks)}</Text>
          {status.pending > 0 ? (
            <Text style={styles.line}>{t.watcher.pending(status.pending)}</Text>
          ) : null}
          <Text style={styles.line}>
            {t.watcher.spend(spend.text)}
            {spend.estimate ? (
              <Text style={styles.dim}>{` (${t.watcher.spendEstimate})`}</Text>
            ) : null}
          </Text>
          <Text style={styles.line}>
            {t.watcher.hourlyCap(status.hourlyCap.used, status.hourlyCap.limit)}
          </Text>
          {status.problem ? (
            <View style={styles.problem}>
              <Text style={styles.problemTitle}>{t.watcher.problemTitle}</Text>
              <Text style={styles.line}>
                {t.watcher.problem[status.problem.problemCode] ?? status.problem.message}
              </Text>
            </View>
          ) : null}
          <Muted>{t.watcher.report}</Muted>
          <Mono style={styles.path}>
            <Text selectable>{status.reportPath}</Text>
          </Mono>
          <Muted style={styles.hint}>{t.watcher.onlyPanel}</Muted>
          {turnOff.isError ? (
            <Text style={styles.error}>
              {t.watcher.turnOffFailed(
                turnOff.error instanceof Error ? turnOff.error.message : String(turnOff.error),
              )}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              title={t.watcher.close}
              tone="ghost"
              style={styles.grow}
              onPress={() => setOpen(false)}
            />
            <Button
              title={t.watcher.turnOff}
              tone="danger"
              style={styles.grow}
              busy={turnOff.isPending}
              onPress={() => turnOff.mutate()}
            />
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

/** Секундный такт, пока значок на экране: время работы идёт на глазах. */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    // Отступ несёт сам значок: выключенный наблюдатель не оставляет пустой полосы.
    marginHorizontal: space.lg,
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  pressed: { opacity: 0.7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  dotBusy: { backgroundColor: colors.running },
  dotProblem: { backgroundColor: colors.warning },
  chipText: { color: colors.text, fontSize: font.small },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: space.lg,
    gap: space.sm,
  },
  title: { color: colors.text, fontSize: font.title, fontWeight: '600' },
  line: { color: colors.text, fontSize: font.body },
  dim: { color: colors.textDim },
  problem: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    paddingLeft: space.md,
    gap: space.xs,
  },
  problemTitle: { color: colors.warning, fontSize: font.body, fontWeight: '600' },
  path: { color: colors.textDim },
  hint: { marginTop: space.xs },
  error: { color: colors.danger, fontSize: font.small },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  grow: { flex: 1 },
});
