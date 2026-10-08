import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Mono, Muted } from '../../shared/ui';
import { useT } from '../../shared/config/i18n';
import { useCostUnit } from '../../entities/settings/api';
import { useWatcherStatus } from '../../entities/watcher/api';
import { watcherVisible } from '../../entities/watcher/model';
import { useTurnOffWatcher } from '../../entities/watcher/useTurnOffWatcher';
import { watcherElapsedMs } from '../../entities/watcher/watcherElapsedMs';
import { formatUptime } from '../../entities/watcher/formatUptime';
import { watcherSpendText } from '../../entities/watcher/watcherSpendText';
import { useTicking } from './useTicking';
import { styles } from './WatcherChip.styles';

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
