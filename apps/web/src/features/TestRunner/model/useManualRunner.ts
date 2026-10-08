import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProjectTestGroup,
  ProjectTestPoint,
  ProjectTestPointResult,
  ProjectTestSharedStep,
  ProjectTestStatus,
  ProjectTestStep,
  ProjectTestStepResult,
} from '@agentdeck/contracts';
import {
  useFinishManualRun,
  useManualSession,
  useSaveManualResult,
  useStartManualRun,
  useUploadTestAttachment,
  type StartManualPayload,
} from '@entities/ProjectTest';
import { resolveSteps } from '../lib/resolveSteps';
import { nextOpenPoint } from '../lib/nextOpenPoint';
import { patchStepResult } from '../lib/patchStepResult';
import { toBase64 } from '../lib/toBase64';
import { savedFor } from '../lib/savedFor';

/**
 * Ход ручного прохода.
 *
 * Сессия живёт на сервере (файл прогона), а здесь — только то, что человек
 * набирает по текущему поинту и ещё не отправил: статусы шагов, заметка,
 * вложения, секундомер. Отправка результата закрывает поинт целиком, потому что
 * половина отмеченного шага — это не результат, а незаконченная работа, и
 * восстанавливать её после F5 неоткуда и незачем.
 *
 * Текст шагов собирается ЗДЕСЬ, а не берётся из поинта: поинт знает только
 * кейс, окружение и значения параметров, а увидеть человек должен уже
 * раскрытые общие шаги и подставленные значения — то же, что увидел бы агент.
 */
export interface ManualRunner {
  isActive: boolean;
  points: ProjectTestPoint[];
  /** Уже отправленные результаты — по ним рисуются галочки списка слева. */
  results: ProjectTestPointResult[];
  index: number;
  point?: ProjectTestPoint;
  /** Шаги текущего поинта: общие раскрыты, параметры подставлены. */
  steps: ProjectTestStep[];
  /** Заголовок кейса и его сопроводительные поля. */
  precondition?: string;
  expected?: string;
  stepResults: ProjectTestStepResult[];
  setStepStatus: (index: number, status: ProjectTestStatus) => void;
  setStepNote: (index: number, note: string) => void;
  note: string;
  setNote: (note: string) => void;
  attachments: string[];
  attach: (file: File) => Promise<void>;
  isAttaching: boolean;
  /** Секунды на текущем поинте — по ним считается длительность прохода. */
  elapsedMs: number;
  done: number;
  total: number;
  goto: (index: number) => void;
  submit: (status: ProjectTestStatus) => Promise<void>;
  start: (payload: StartManualPayload) => Promise<unknown>;
  finish: () => void;
  cancel: () => void;
  isBusy: boolean;
  /** Группа и кейс текущего поинта — по ним заводится дефект. */
  current?: { groupId: string; caseId: string; runId: string };
}

export function useManualRunner(
  projectPath: string | undefined,
  groups: ProjectTestGroup[],
  sharedSteps: ProjectTestSharedStep[],
  isEnabled: boolean,
): ManualRunner {
  const query = useManualSession(projectPath, isEnabled);
  const session = query.data ?? undefined;

  const start = useStartManualRun(projectPath);
  const save = useSaveManualResult(projectPath);
  const finish = useFinishManualRun(projectPath);
  const upload = useUploadTestAttachment(projectPath);

  const [cursor, setCursor] = useState(0);
  const [stepResults, setStepResults] = useState<ProjectTestStepResult[]>([]);
  const [note, setNote] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsed] = useState(0);

  const points = useMemo(() => session?.points ?? [], [session]);
  const point = points[cursor];

  // Сервер сам двигает указатель по мере результатов; локальный курсор
  // подхватывает его при первом появлении сессии и при её смене, но не мешает
  // человеку листать назад к уже пройденному.
  useEffect(() => {
    if (session) setCursor(session.index);
  }, [session?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const caseOf = useCallback(
    (groupId: string, caseId: string) =>
      groups.find((group) => group.id === groupId)?.cases.find((item) => item.id === caseId),
    [groups],
  );

  const testCase = point ? caseOf(point.groupId, point.caseId) : undefined;

  const steps = useMemo(
    () => resolveSteps(testCase?.steps, sharedSteps, point?.params ?? {}),
    [testCase, sharedSteps, point],
  );

  // Смена поинта обнуляет всё, что относилось к прошлому.
  useEffect(() => {
    const saved = savedFor(session, point?.id);
    setStepResults(saved.steps);
    setNote(saved.note);
    setAttachments(saved.attachments);
    setStartedAt(Date.now());
    setElapsed(0);
  }, [point?.id, session?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!point) return undefined;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [point?.id, startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchStep = (index: number, part: Partial<ProjectTestStepResult>): void => {
    setStepResults((current) => patchStepResult(current, index, part));
  };

  const submit = async (status: ProjectTestStatus): Promise<void> => {
    if (!session || !point) return;
    const saved = await save.mutateAsync({
      runId: session.runId,
      pointId: point.id,
      status,
      note,
      steps: stepResults,
      attachments,
      durationMs: Date.now() - startedAt,
    });
    setCursor((value) => nextOpenPoint(points, saved?.results ?? [], value));
  };

  const attach = async (file: File): Promise<void> => {
    if (!point) return;
    const contentBase64 = await toBase64(file);
    const saved = await upload.mutateAsync({
      caseId: point.caseId,
      name: file.name,
      contentBase64,
    });
    setAttachments((current) => [...current, saved]);
  };

  const done = session?.results.length ?? 0;

  return {
    isActive: Boolean(session && !session.finishedAt),
    points,
    results: session?.results ?? [],
    index: cursor,
    point,
    steps,
    precondition: testCase?.precondition,
    expected: testCase?.expected,
    stepResults,
    setStepStatus: (index, status) => patchStep(index, { status }),
    setStepNote: (index, value) => patchStep(index, { note: value }),
    note,
    setNote,
    attachments,
    attach,
    isAttaching: upload.isPending,
    elapsedMs,
    done,
    total: points.length,
    goto: (index) => setCursor(Math.max(0, Math.min(index, points.length - 1))),
    submit,
    start: (payload) => start.mutateAsync(payload),
    finish: () => session && finish.mutate({ runId: session.runId }),
    cancel: () => session && finish.mutate({ runId: session.runId, isCancelled: true }),
    isBusy: start.isPending || save.isPending || finish.isPending,
    ...(session && point
      ? { current: { groupId: point.groupId, caseId: point.caseId, runId: session.runId } }
      : {}),
  };
}
