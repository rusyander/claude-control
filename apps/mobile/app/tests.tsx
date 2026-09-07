import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import type { ProjectTestCase } from '@agentdeck/contracts';
import {
  Button,
  Card,
  Empty,
  Field,
  Loading,
  Mono,
  Muted,
  Row,
  Screen,
  Title,
} from '../src/shared/ui';
import { colors, font, radius, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useWorkspace } from '../src/shared/lib/workspace';
import {
  useInstallTestConvention,
  useProjectTests,
  useRemoveTestCase,
  useSaveTestCase,
  useStartManualRun,
  useStartTestRun,
  useStopTestRun,
} from '../src/entities/tests/api';
import { formatWhen } from '../src/entities/tests/status';
import { TestCaseEditor } from '../src/features/tests/TestCaseEditor';
import { TestCaseRow } from '../src/features/tests/TestCaseRow';
import { TestLinks } from '../src/features/tests/TestLinks';
import {
  EMPTY_FILTER,
  TestFilters,
  filterCases,
  isFilterEmpty,
  type TestFilterState,
} from '../src/features/tests/TestFilters';

/**
 * Тест-кейсы проекта на телефоне: те же файлы `.agent/tests/`, что в панели.
 *
 * Прогон АГЕНТА отсюда ничем не отличается от запуска из панели — работает всё
 * равно агент на компьютере. Это и есть смысл экрана: посмотреть, что красное,
 * и перезапустить прогон, не подходя к машине. Ручной прогон — наоборот, вещь
 * именно телефонная: приложение проверяют глазами, часто на этом же устройстве,
 * и отметить результат надо там же, где смотрят.
 *
 * Группы — вкладками строкой, а не выпадающим списком: их две-три, и лишний
 * тап ради переключения между GUI и E2E не окупается.
 */
export default function TestsScreen() {
  const t = useT();
  const workspace = useWorkspace();
  const projectPath = workspace.projectPath;

  const tests = useProjectTests(projectPath);
  const start = useStartTestRun(projectPath);
  const stop = useStopTestRun(projectPath);
  const save = useSaveTestCase(projectPath);
  const remove = useRemoveTestCase(projectPath);
  const convention = useInstallTestConvention(projectPath);
  const startManual = useStartManualRun(projectPath);

  const [groupId, setGroupId] = useState('');
  const [scope, setScope] = useState('');
  const [release, setRelease] = useState('');
  const [filter, setFilter] = useState<TestFilterState>(EMPTY_FILTER);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<ProjectTestCase | undefined>();
  const [isEditorOpen, setEditorOpen] = useState(false);

  const groups = tests.data?.groups ?? [];
  const active = groups.find((group) => group.id === groupId) ?? groups[0];
  const run = tests.data?.run;
  const isRunning = run?.status === 'running';

  const cases = useMemo(() => active?.cases ?? [], [active]);
  const shown = useMemo(() => filterCases(cases, filter), [cases, filter]);
  const counts = useMemo(
    () => ({
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      rest: cases.filter((item) => item.status !== 'passed' && item.status !== 'failed').length,
    }),
    [cases],
  );
  // Последний результат по всей группе: он отвечает на вопрос «эти галочки
  // вообще свежие?» — без даты зелёный список полугодовой давности читается
  // как сегодняшний.
  const lastRunAt = useMemo(
    () =>
      cases
        .map((item) => item.lastRunAt ?? '')
        .sort()
        .at(-1) ?? '',
    [cases],
  );

  const toggleSelected = (caseId: string): void =>
    setSelected((list) =>
      list.includes(caseId) ? list.filter((item) => item !== caseId) : [...list, caseId],
    );

  const openManual = (): void => {
    if (!active) return;
    startManual.mutate(
      { groupId: active.id, caseIds: selected.length > 0 ? selected : undefined },
      { onSuccess: () => router.push('/test-run') },
    );
  };

  if (!projectPath) {
    return (
      <>
        <Stack.Screen options={{ title: t.tests.title }} />
        <Empty text={t.tests.noProject} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t.tests.screenTitle }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={tests.isFetching}
            onRefresh={() => void tests.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        <Card>
          <Muted>{t.tests.where(tests.data?.dir ?? '.agent/tests')}</Muted>
          {/* К чему привязан проект — до кнопок запуска: требования открывают
              ПЕРЕД прогоном, а не после того, как что-то покраснело. */}
          <TestLinks projectPath={projectPath} groupId={active?.id} />
          <Field
            value={scope}
            onChangeText={setScope}
            placeholder={t.tests.scope}
            autoCapitalize="sentences"
          />
          {/* Веха прогона: без неё отчёт отвечает только на «как дела сейчас»,
              а спрашивают «что проверено в этом релизе». */}
          <Field
            value={release}
            onChangeText={setRelease}
            placeholder={t.tests.release}
            autoCapitalize="none"
          />
          <Row gap={space.xs}>
            <Button
              title={t.tests.generate}
              onPress={() =>
                start.mutate({ mode: 'generate', groupId: active?.id, scope, release })
              }
              disabled={isRunning}
              busy={start.isPending && !isRunning}
              style={styles.grow}
            />
            <Button
              title={t.tests.run}
              tone="accent"
              onPress={() =>
                start.mutate({
                  mode: 'run',
                  groupId: active?.id,
                  caseIds: selected.length > 0 ? selected : undefined,
                  scope,
                  release,
                })
              }
              disabled={isRunning || cases.length === 0}
              style={styles.grow}
            />
          </Row>
          <Row gap={space.xs}>
            <Button
              title={t.tests.runFull}
              onPress={() =>
                start.mutate({ mode: 'run', groupId: active?.id, scope, release, full: true })
              }
              disabled={isRunning || cases.length === 0}
              style={styles.grow}
            />
            {isRunning ? (
              <Button
                title={t.tests.stop}
                tone="danger"
                onPress={() => stop.mutate(undefined as never)}
                style={styles.grow}
              />
            ) : null}
          </Row>
          <Row gap={space.xs}>
            <Button
              title={
                selected.length > 0
                  ? t.tests.manual.openSelected(selected.length)
                  : t.tests.manual.open
              }
              onPress={openManual}
              busy={startManual.isPending}
              disabled={cases.length === 0}
              style={styles.grow}
            />
            <Button
              title={t.tests.runs.open}
              onPress={() => router.push('/test-runs')}
              style={styles.grow}
            />
          </Row>
          <Muted>{t.tests.onComputer}</Muted>
          {/* Прогон отсюда отдаёт формат агенту сам, а просьба из чата — нет:
              её подхватит только CLAUDE.md проекта. */}
          {tests.data?.hasConvention ? (
            <Text style={styles.good}>{t.tests.conventionOn}</Text>
          ) : (
            <>
              <Text style={styles.warn}>{t.tests.conventionOff}</Text>
              <Button
                title={t.tests.conventionInstall}
                onPress={() => convention.mutate(undefined as never)}
                busy={convention.isPending}
              />
            </>
          )}
          {run ? (
            <Text style={styles.runState}>{runLabel(run.status, run.mode, run.error, t)}</Text>
          ) : null}
          {start.error ? <Text style={styles.bad}>{(start.error as Error).message}</Text> : null}
          {startManual.error ? (
            <Text style={styles.bad}>{(startManual.error as Error).message}</Text>
          ) : null}
        </Card>

        {groups.length > 1 ? (
          <Row gap={space.xs}>
            {groups.map((group) => (
              <Pressable
                key={group.id}
                onPress={() => setGroupId(group.id)}
                style={[styles.tab, group.id === active?.id && styles.tabOn]}
              >
                <Text style={styles.tabText}>
                  {group.title} ({group.cases.length})
                </Text>
              </Pressable>
            ))}
          </Row>
        ) : null}

        {tests.isLoading ? <Loading /> : null}

        {groups.length === 0 && !tests.isLoading ? (
          <Card>
            <Title>{t.tests.empty}</Title>
            <Muted>{t.tests.emptyHint}</Muted>
          </Card>
        ) : null}

        {active?.error ? (
          <Card>
            <Text style={styles.bad}>{t.tests.broken(active.error)}</Text>
            <Muted>{t.tests.brokenHint}</Muted>
          </Card>
        ) : null}

        {active && !active.error ? (
          <Card>
            <Row gap={space.sm}>
              <Title style={styles.grow}>{active.title}</Title>
              <Pressable
                onPress={() => {
                  setEditing(undefined);
                  setEditorOpen(true);
                }}
              >
                <Text style={styles.action}>{t.tests.addCase}</Text>
              </Pressable>
            </Row>
            <Muted>{t.tests.counts(counts.passed, counts.failed, counts.rest)}</Muted>
            <Muted>
              {lastRunAt ? t.tests.lastRun(formatWhen(lastRunAt)) : t.tests.lastRunNever}
            </Muted>

            <TestFilters cases={cases} filter={filter} onChange={setFilter} />
            {!isFilterEmpty(filter) ? (
              <Row gap={space.sm}>
                <Muted style={styles.grow}>
                  {t.tests.filter.shown(shown.length, cases.length)}
                </Muted>
                <Pressable onPress={() => setFilter(EMPTY_FILTER)}>
                  <Text style={styles.action}>{t.tests.filter.reset}</Text>
                </Pressable>
              </Row>
            ) : null}
            {selected.length > 0 ? (
              <Row gap={space.sm}>
                <Muted style={styles.grow}>{t.tests.selected(selected.length)}</Muted>
                <Pressable onPress={() => setSelected([])}>
                  <Text style={styles.action}>{t.tests.clearSelection}</Text>
                </Pressable>
              </Row>
            ) : null}

            {cases.length === 0 ? <Muted>{t.tests.emptyGroup}</Muted> : null}
            {cases.length > 0 && shown.length === 0 ? (
              <Muted>{t.tests.filter.nothing}</Muted>
            ) : null}

            <View style={styles.list}>
              {shown.map((testCase) => (
                <TestCaseRow
                  key={testCase.id}
                  testCase={testCase}
                  isSelected={selected.includes(testCase.id)}
                  onToggleSelected={() => toggleSelected(testCase.id)}
                  onEdit={() => {
                    setEditing(testCase);
                    setEditorOpen(true);
                  }}
                  onRemove={() => remove.mutate({ groupId: active.id, caseId: testCase.id })}
                />
              ))}
            </View>
          </Card>
        ) : null}

        {/* Лог — последним: во время прогона за ним следят, но искать по нему
            нечего, а сверху он отодвинул бы кнопки и список. */}
        {run?.log ? (
          <Card>
            <Title>{t.tests.log}</Title>
            <Mono style={styles.log}>{run.log.slice(-4000)}</Mono>
          </Card>
        ) : null}
      </Screen>

      <TestCaseEditor
        isOpen={isEditorOpen}
        testCase={editing}
        onClose={() => setEditorOpen(false)}
        onSave={async (input) => {
          if (active) await save.mutateAsync({ groupId: active.id, testCase: input });
          setEditorOpen(false);
        }}
      />
    </>
  );
}

/** Подпись состояния прогона одной строкой. */
function runLabel(
  status: string,
  mode: string,
  error: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (status === 'running') return mode === 'generate' ? t.tests.generating : t.tests.running;
  if (status === 'stopped') return t.tests.stopped;
  if (status === 'error') return t.tests.failed(error ?? '');
  return t.tests.done;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  list: { gap: space.xs, paddingTop: space.xs },
  tab: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  tabText: { color: colors.text, fontSize: font.small },
  action: { color: colors.accent, fontSize: font.small },
  good: { color: colors.success },
  bad: { color: colors.danger, fontSize: font.small },
  warn: { color: colors.warning },
  runState: { color: colors.textDim, fontSize: font.small },
  log: { color: colors.textDim, fontSize: font.small },
});
