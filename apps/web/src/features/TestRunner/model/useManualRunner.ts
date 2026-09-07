import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ProjectTestGroup,
  ProjectTestManualSession,
  ProjectTestPoint,
  ProjectTestPointResult,
  ProjectTestSharedStep,
  ProjectTestStatus,
  ProjectTestStep,
  ProjectTestStepResult,
} from '@agentdeck/contracts';
import { applyParams, expandSteps } from '@agentdeck/contracts/test-format';
import {
  useFinishManualRun,
  useManualSession,
  useSaveManualResult,
  useStartManualRun,
  useUploadTestAttachment,
  type StartManualPayload,
} from '@entities/ProjectTest';

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

/**
 * Шаги поинта в том виде, в каком их читает человек: общие раскрыты, значения
 * параметров подставлены. Отдельной функцией — по ней и проверяется, что
 * тестировщик и агент видят один и тот же текст.
 */
export function resolveSteps(
  steps: ProjectTestStep[] | undefined,
  sharedSteps: ProjectTestSharedStep[],
  params: Record<string, string> = {},
): ProjectTestStep[] {
  if (!steps) return [];
  return expandSteps(steps, sharedSteps).map((step) => ({
    action: applyParams(step.action, params),
    ...(step.expected ? { expected: applyParams(step.expected, params) } : {}),
    ...(step.data ? { data: applyParams(step.data, params) } : {}),
  }));
}

/**
 * Секундомер как `мм:сс` — без часов: один проход столько не идёт.
 *
 * Живёт рядом с самим секундомером, а не в разметке: время поинта уходит в
 * результат прогона, и показанное человеку обязано быть тем же числом.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** То, что уже отмечено по поинту: с ним человек и возвращается к пройденному. */
export interface SavedPoint {
  steps: ProjectTestStepResult[];
  note: string;
  attachments: string[];
}

/**
 * Отмеченное по поинту из сессии.
 *
 * Переход на другой поинт обязан класть в форму ЕГО отметки, а не остатки
 * прошлого: чужая заметка, приехавшая на новый кейс, — худший вид испорченного
 * результата, потому что выглядит она как настоящая.
 */
export function savedFor(
  session: ProjectTestManualSession | undefined,
  pointId: string | undefined,
): SavedPoint {
  const saved = session?.results.find((item) => item.pointId === pointId);
  return {
    steps: saved?.steps ?? [],
    note: saved?.note ?? '',
    attachments: saved?.attachments ?? [],
  };
}

/** Отметка по шагу: строка либо дописывается, либо заводится со статусом «нет». */
export function patchStepResult(
  results: ProjectTestStepResult[],
  index: number,
  part: Partial<ProjectTestStepResult>,
): ProjectTestStepResult[] {
  const found = results.find((item) => item.index === index);
  if (found) {
    return results.map((item) => (item.index === index ? { ...item, ...part } : item));
  }
  return [...results, { index, status: 'unknown' as ProjectTestStatus, ...part }];
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
    await save.mutateAsync({
      runId: session.runId,
      pointId: point.id,
      status,
      note,
      steps: stepResults,
      attachments,
      durationMs: Date.now() - startedAt,
    });
    setCursor((value) => Math.min(value + 1, points.length - 1));
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

/**
 * Файл в base64 без префикса `data:`.
 *
 * Читается через FileReader, а не через `arrayBuffer` + ручную кодировку:
 * скриншот на пару мегабайт при ручной сборке строки из байтов кладёт вкладку,
 * а браузер делает то же самое нативно.
 */
export async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
