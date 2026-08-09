import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { ProjectTestCase, ProjectTestStatus } from '@claude-control/contracts';
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
  useStartTestRun,
  useStopTestRun,
} from '../src/entities/tests/api';
import { TestCaseEditor } from '../src/features/tests/TestCaseEditor';

/**
 * Тест-кейсы проекта на телефоне: те же файлы `.agent/tests/`, что в панели.
 *
 * Запуск отсюда ничем не отличается от запуска из панели — работает всё равно
 * агент на компьютере. Это и есть смысл экрана: посмотреть, что красное, и
 * перезапустить прогон, не подходя к машине.
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

  const [groupId, setGroupId] = useState('');
  const [scope, setScope] = useState('');
  const [editing, setEditing] = useState<ProjectTestCase | undefined>();
  const [isEditorOpen, setEditorOpen] = useState(false);

  const groups = tests.data?.groups ?? [];
  const active = groups.find((group) => group.id === groupId) ?? groups[0];
  const run = tests.data?.run;
  const isRunning = run?.status === 'running';

  const counts = useMemo(() => {
    const cases = active?.cases ?? [];
    return {
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      rest: cases.filter((item) => item.status !== 'passed' && item.status !== 'failed').length,
    };
  }, [active]);

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
          <Field
            value={scope}
            onChangeText={setScope}
            placeholder={t.tests.scope}
            autoCapitalize="sentences"
          />
          <Row gap={space.xs}>
            <Button
              title={t.tests.generate}
              onPress={() => start.mutate({ mode: 'generate', groupId: active?.id, scope })}
              disabled={isRunning}
              busy={start.isPending && !isRunning}
              style={styles.grow}
            />
            <Button
              title={t.tests.run}
              tone="accent"
              onPress={() => start.mutate({ mode: 'run', groupId: active?.id, scope })}
              disabled={isRunning || (active?.cases.length ?? 0) === 0}
              style={styles.grow}
            />
          </Row>
          <Row gap={space.xs}>
            <Button
              title={t.tests.runFull}
              onPress={() => start.mutate({ mode: 'run', groupId: active?.id, scope, full: true })}
              disabled={isRunning || (active?.cases.length ?? 0) === 0}
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
                <Text style={styles.add}>{t.tests.addCase}</Text>
              </Pressable>
            </Row>
            <Muted>{t.tests.counts(counts.passed, counts.failed, counts.rest)}</Muted>

            {active.cases.length === 0 ? <Muted>{t.tests.emptyGroup}</Muted> : null}

            <View style={styles.list}>
              {active.cases.map((testCase) => (
                <TestRow
                  key={testCase.id}
                  testCase={testCase}
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

/** Одна строка списка: статус, название и что агент увидел. */
function TestRow({
  testCase,
  onEdit,
  onRemove,
}: {
  testCase: ProjectTestCase;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [isOpen, setOpen] = useState(false);

  return (
    <View style={[styles.case, testCase.status === 'failed' && styles.caseFailed]}>
      <Pressable onPress={() => setOpen((value) => !value)}>
        <Row gap={space.xs}>
          <Text style={[styles.mark, markStyle(testCase.status)]}>{MARK[testCase.status]}</Text>
          <Text style={styles.caseTitle} numberOfLines={isOpen ? undefined : 2}>
            {testCase.title}
          </Text>
        </Row>
        {testCase.area ? <Muted>{testCase.area}</Muted> : null}
      </Pressable>

      {isOpen ? (
        <View style={styles.details}>
          {testCase.purpose ? <Muted>{testCase.purpose}</Muted> : null}
          {testCase.steps.map((step, index) => (
            <Text key={index} style={styles.step}>
              {index + 1}. {step}
            </Text>
          ))}
          {testCase.expected ? <Muted>→ {testCase.expected}</Muted> : null}
          {testCase.note ? (
            <Text style={testCase.status === 'failed' ? styles.bad : styles.note}>
              {testCase.note}
            </Text>
          ) : null}
          <Muted>
            {testCase.id} · {t.tests.status[testCase.status]} · {t.tests.source[testCase.source]}
          </Muted>
          <Row gap={space.sm}>
            <Pressable onPress={onEdit}>
              <Text style={styles.add}>{t.tests.editCase}</Text>
            </Pressable>
            <Pressable onPress={onRemove}>
              <Text style={styles.bad}>{t.tests.remove}</Text>
            </Pressable>
          </Row>
        </View>
      ) : null}
    </View>
  );
}

/** Значок статуса. Символ, а не цвет: цвет один не читается при ярком солнце. */
const MARK: Record<ProjectTestStatus, string> = {
  passed: '✓',
  failed: '✕',
  skipped: '–',
  running: '…',
  unknown: '·',
};

function markStyle(status: ProjectTestStatus) {
  if (status === 'passed') return styles.good;
  if (status === 'failed') return styles.bad;
  if (status === 'skipped') return styles.warn;
  return styles.dim;
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
  case: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  caseFailed: { borderColor: colors.danger },
  caseTitle: { color: colors.text, fontSize: font.body, flex: 1 },
  mark: { fontSize: font.body, width: 18, textAlign: 'center' },
  details: { gap: space.xs },
  step: { color: colors.textDim, fontSize: font.small },
  note: { color: colors.textDim, fontSize: font.small },
  add: { color: colors.accent, fontSize: font.small },
  good: { color: colors.success },
  bad: { color: colors.danger, fontSize: font.small },
  warn: { color: colors.warning },
  dim: { color: colors.textFaint },
  runState: { color: colors.textDim, fontSize: font.small },
  log: { color: colors.textDim, fontSize: font.small },
});
