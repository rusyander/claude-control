import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { Card, Empty, Loading, Muted, Row, Screen, Title } from '../src/shared/ui';
import { colors, font, radius, space } from '../src/shared/config/theme';
import { useT, useLanguage } from '../src/shared/config/i18n';
import { useWorkspace } from '../src/shared/lib/workspace';
import { runLabel } from '../src/entities/tests/runLabel';
import { useTestRuns } from '../src/entities/tests/useTestRuns';
import { formatWhen } from '../src/entities/tests/formatWhen';
import { serverField } from '../src/shared/api/serverField';

/**
 * История прогонов: файлы `runs/*.run.json` того же проекта, от новых к старым.
 *
 * Отчёт с трендами и нестабильными кейсами остаётся панели — на телефоне он
 * превратился бы в горизонтальную прокрутку таблицы. Здесь отвечают на другой
 * вопрос, и он единственный, который задают в руке: «чем кончился последний
 * прогон и кто его гонял».
 *
 * Ветка и коммит показаны рядом со сводкой намеренно: зелёный прогон недельной
 * давности с чужой ветки — это не «у нас всё хорошо».
 */
export default function TestRunsScreen() {
  const t = useT();
  const workspace = useWorkspace();
  const runs = useTestRuns(workspace.projectPath);

  if (!workspace.projectPath) {
    return (
      <>
        <Stack.Screen options={{ title: t.tests.runs.title }} />
        <Empty text={t.tests.noProject} />
      </>
    );
  }

  const records = runs.data ?? [];

  return (
    <>
      <Stack.Screen options={{ title: t.tests.runs.title }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={runs.isFetching}
            onRefresh={() => void runs.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        {runs.isLoading ? <Loading /> : null}
        {runs.error ? (
          <Card>
            <Text style={styles.bad}>{(runs.error as Error).message}</Text>
          </Card>
        ) : null}
        {!runs.isLoading && records.length === 0 ? (
          <Card>
            <Muted>{t.tests.runs.empty}</Muted>
          </Card>
        ) : null}

        <View style={styles.list}>
          {records.map((record) => (
            <RunRow key={record.id} record={record} />
          ))}
        </View>
      </Screen>
    </>
  );
}

function RunRow({ record }: { record: ProjectTestRunRecord }) {
  const language = useLanguage();
  const t = useT();
  const summary = record.summary;
  const isBad = record.status === 'error' || summary.failed > 0;
  const label = runLabel(record, t.tests.runs);

  return (
    <View style={[styles.run, isBad && styles.runBad]}>
      <Row gap={space.sm}>
        <Title style={styles.grow} numberOfLines={1}>
          {label.title}
        </Title>
        <Muted>{t.tests.runs.state[record.status]}</Muted>
      </Row>
      <Muted>{formatWhen(record.startedAt, language)}</Muted>
      <Text style={styles.summary}>
        {t.tests.runs.summary(summary.passed, summary.failed, summary.skipped, summary.blocked)}
      </Text>
      <Muted>
        {[
          label.actor,
          record.groupId,
          record.branch,
          record.commit?.slice(0, 7),
          record.tokens ? t.tests.runs.spent(record.tokens) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </Muted>
      {/* Текст записи — по коду на языке телефона: сырой `error` сервер пишет
          по-русски, и английский телефон показывал его как есть (F-360). */}
      {record.error ? <Text style={styles.bad}>{serverField(record, 'error')}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  list: { gap: space.sm },
  run: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  runBad: { borderColor: colors.danger },
  summary: { color: colors.text, fontSize: font.small },
  bad: { color: colors.danger, fontSize: font.small },
});
