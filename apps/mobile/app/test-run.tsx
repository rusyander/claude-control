import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Stack, router } from 'expo-router';
import type { ProjectTestStatus, ProjectTestStepResult } from '@agentdeck/contracts';
import { stepText, toSteps } from '@agentdeck/contracts/test-format';
import { Button, Card, Empty, Field, Loading, Muted, Row, Screen, Title } from '../src/shared/ui';
import { colors, font, radius, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useWorkspace } from '../src/shared/lib/workspace';
import {
  useCloseManualRun,
  useManualSession,
  useProjectTests,
  useSaveManualResult,
} from '../src/entities/tests/api';
import { STATUS_MARK, statusColor } from '../src/entities/tests/status';

/**
 * Ручной прогон: проверяет человек, панель записывает.
 *
 * Единственный экран тестов, ради которого стоит доставать телефон во время
 * проверки: приложение открыто рядом (иногда на этом же устройстве), и отметить
 * шаг надо там же, где смотрят, а не потом по памяти за компьютером.
 *
 * Сессия живёт на СЕРВЕРЕ — её начинают здесь и дописывают в панели, и
 * наоборот. Поэтому экран не хранит своих результатов: он показывает то, что
 * вернул сервер, а отметка уходит запросом сразу, а не пачкой в конце. Прогон,
 * прерванный на середине (сел телефон, ушли в другое приложение), не теряет уже
 * отмеченного.
 *
 * Шаги отмечаются по одному тапу с перебором «не проверялся → прошёл →
 * провален»: на сенсорном экране три кнопки на каждый шаг съели бы всю ширину.
 * Итог кейса ставится явными кнопками — это решение, а не перебор.
 */
export default function TestRunScreen() {
  const t = useT();
  const workspace = useWorkspace();
  const projectPath = workspace.projectPath;

  const session = useManualSession(projectPath);
  const tests = useProjectTests(projectPath);
  const saveResult = useSaveManualResult(projectPath);
  const close = useCloseManualRun(projectPath);

  const [index, setIndex] = useState(0);
  const [note, setNote] = useState('');
  const [stepStatuses, setStepStatuses] = useState<ProjectTestStatus[]>([]);

  const data = session.data;
  const points = useMemo(() => data?.points ?? [], [data]);
  const point = points[index];
  const runId = data?.runId ?? '';

  // Кейс со всеми подробностями лежит в списке групп, а не в тест-поинте:
  // поинт — это «что пройти», описание — «как». Тянуть шаги в поинт значило бы
  // дублировать файл группы в записи прогона.
  const testCase = useMemo(() => {
    if (!point) return undefined;
    const group = tests.data?.groups.find((item) => item.id === point.groupId);
    return group?.cases.find((item) => item.id === point.caseId);
  }, [point, tests.data]);
  const steps = useMemo(() => toSteps(testCase?.steps ?? []), [testCase]);

  // При переходе на другой поинт заметка и галочки шагов берутся из уже
  // записанного результата: вернуться назад и увидеть пустое поле там, где
  // только что писал, — потерять работу на ровном месте.
  useEffect(() => {
    const saved = data?.results.find((item) => item.pointId === point?.id);
    setNote(saved?.note ?? '');
    setStepStatuses(steps.map((_, at) => saved?.steps?.[at]?.status ?? 'unknown'));
  }, [data, point?.id, steps]);

  const cycleStep = (at: number): void =>
    setStepStatuses((list) =>
      list.map((status, position) =>
        position === at ? (NEXT_STEP_STATUS[status] ?? 'unknown') : status,
      ),
    );

  const mark = (status: ProjectTestStatus): void => {
    if (!point) return;
    const results: ProjectTestStepResult[] = stepStatuses
      .map((value, at) => ({ index: at, status: value }))
      .filter((item) => item.status !== 'unknown');
    saveResult.mutate(
      {
        runId,
        pointId: point.id,
        status,
        note: note.trim() || undefined,
        steps: results.length > 0 ? results : undefined,
      },
      // Дальше — сам: человек проверяет подряд, и лишний тап «дальше» после
      // каждой отметки стоит ровно столько же, сколько сама отметка.
      { onSuccess: () => setIndex((value) => Math.min(value + 1, points.length - 1)) },
    );
  };

  if (!projectPath) {
    return (
      <>
        <Stack.Screen options={{ title: t.tests.manual.title }} />
        <Empty text={t.tests.noProject} />
      </>
    );
  }

  if (session.isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: t.tests.manual.title }} />
        <Loading />
      </>
    );
  }

  if (!data || !point) {
    return (
      <>
        <Stack.Screen options={{ title: t.tests.manual.title }} />
        <Screen scroll>
          <Card>
            <Title>{t.tests.manual.none}</Title>
            <Muted>{t.tests.manual.noneHint}</Muted>
            <Button title={t.common.close} onPress={() => router.back()} />
          </Card>
        </Screen>
      </>
    );
  }

  const done = data.results.length;

  return (
    <>
      <Stack.Screen options={{ title: t.tests.manual.title }} />
      <Screen scroll>
        <Card>
          <Muted>{t.tests.manual.onDevice}</Muted>
          <Row gap={space.sm}>
            <Muted style={styles.grow}>{t.tests.manual.position(index + 1, points.length)}</Muted>
            <Muted>{t.tests.manual.progress(done, points.length)}</Muted>
          </Row>
          <Title>{point.title}</Title>
          {testCase?.precondition ? (
            <Muted>
              {t.tests.casePrecondition}: {testCase.precondition}
            </Muted>
          ) : null}
          {point.params ? (
            <Muted>
              {Object.entries(point.params)
                .map(([name, value]) => `%${name} = ${value}`)
                .join(' · ')}
            </Muted>
          ) : null}
        </Card>

        {steps.length > 0 ? (
          <Card>
            <Title>{t.tests.manual.steps}</Title>
            {steps.map((step, at) => (
              <Pressable key={at} onPress={() => cycleStep(at)} style={styles.step}>
                <Text style={[styles.mark, { color: statusColor(stepStatuses[at] ?? 'unknown') }]}>
                  {STATUS_MARK[stepStatuses[at] ?? 'unknown']}
                </Text>
                <Text style={styles.stepText}>
                  {at + 1}. {stepText(step)}
                </Text>
              </Pressable>
            ))}
          </Card>
        ) : null}

        {testCase?.expected ? (
          <Card>
            <Muted>{t.tests.caseExpected}</Muted>
            <Text style={styles.body}>{testCase.expected}</Text>
            {testCase.oracle ? (
              <Muted>
                {t.tests.caseOracle}: {testCase.oracle}
              </Muted>
            ) : null}
          </Card>
        ) : null}

        <Card>
          <Muted>{t.tests.manual.note}</Muted>
          <Field value={note} onChangeText={setNote} multiline autoCapitalize="sentences" />
          <Row gap={space.xs}>
            <Button
              title={t.tests.manual.passed}
              tone="accent"
              onPress={() => mark('passed')}
              busy={saveResult.isPending}
              style={styles.grow}
            />
            <Button
              title={t.tests.manual.failed}
              tone="danger"
              onPress={() => mark('failed')}
              busy={saveResult.isPending}
              style={styles.grow}
            />
          </Row>
          <Row gap={space.xs}>
            <Button
              title={t.tests.manual.skipped}
              onPress={() => mark('skipped')}
              style={styles.grow}
            />
            <Button
              title={t.tests.manual.blocked}
              onPress={() => mark('blocked')}
              style={styles.grow}
            />
          </Row>
          {saveResult.error ? (
            <Text style={styles.bad}>{(saveResult.error as Error).message}</Text>
          ) : null}
        </Card>

        <Card>
          <Row gap={space.xs}>
            <Button
              title={t.tests.manual.prev}
              onPress={() => setIndex((value) => Math.max(0, value - 1))}
              disabled={index === 0}
              style={styles.grow}
            />
            <Button
              title={t.tests.manual.next}
              onPress={() => setIndex((value) => Math.min(points.length - 1, value + 1))}
              disabled={index >= points.length - 1}
              style={styles.grow}
            />
          </Row>
          <Button
            title={t.tests.manual.finish}
            tone="accent"
            onPress={() => close.mutate({ runId }, { onSuccess: () => router.back() })}
            busy={close.isPending}
          />
          <Button
            title={t.tests.manual.cancel}
            tone="ghost"
            onPress={() =>
              close.mutate({ runId, cancel: true }, { onSuccess: () => router.back() })
            }
          />
        </Card>
      </Screen>
    </>
  );
}

/** Перебор статуса шага по тапу. Заблокированный и пропущенный ставят кейсу. */
const NEXT_STEP_STATUS: Partial<Record<ProjectTestStatus, ProjectTestStatus>> = {
  unknown: 'passed',
  passed: 'failed',
  failed: 'unknown',
};

const styles = StyleSheet.create({
  grow: { flex: 1 },
  body: { color: colors.text, fontSize: font.body },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
  },
  mark: { fontSize: font.title, width: 22, textAlign: 'center' },
  stepText: { color: colors.text, fontSize: font.body, flex: 1 },
  bad: { color: colors.danger, fontSize: font.small },
});
