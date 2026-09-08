import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectTestBulkInput,
  ProjectTestCaseInput,
  ProjectTestDraftSummary,
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestLibraryIssue,
  ProjectTestPlan,
  ProjectTestRun,
  ProjectTestSchema,
  ProjectTestSharedStep,
  ProjectTestView,
} from '@agentdeck/contracts';
import { caseDuration, pickWithinBudget } from '@agentdeck/contracts/test-format';
import {
  useBulkTestCases,
  useCreateTestGroup,
  useInstallTestConvention,
  useProjectTests,
  useRemoveSharedStep,
  useRemoveTestCase,
  useRemoveTestEnvironment,
  useRemoveTestGroup,
  useRemoveTestView,
  useSaveSharedStep,
  useSaveTestCase,
  useSaveTestEnvironment,
  useSaveTestSchema,
  useSaveTestView,
  useSetTestDraftAuto,
  useStartTestRun,
  useTestLint,
  useTestRisk,
  useStopTestRun,
  type StartTestRunPayload,
} from '@entities/ProjectTest';
import { useTestFilters, type TestFilters } from './useTestFilters';

/**
 * Состояние библиотеки тестов: что открыто, что отобрано, что отмечено.
 *
 * Выбор кейсов живёт здесь, а не в таблице, потому что его читают сразу трое —
 * пульт прогона, панель массовых действий и запуск ручного прохода, — а
 * сбрасывать его нужно при смене группы и при смене отбора: иначе человек
 * запустил бы кейсы, которых уже не видит на экране.
 */
export interface TestsBoard {
  isLoading: boolean;
  /** Путь проекта: разделам, которые читают файлы напрямую (история из git). */
  path?: string;
  dir: string;
  groups: ProjectTestGroup[];
  active?: ProjectTestGroup;
  activeId: string;
  select: (id: string) => void;
  /** Отмеченные кейсы. */
  checked: string[];
  toggleCase: (id: string) => void;
  checkAll: () => void;
  clearChecked: () => void;
  /** Отбор и всё, что из него следует: дерево секций, значения фильтров, итог. */
  filters: TestFilters;
  /** Сохранённые наборы — они же динамические наборы тест-планов. */
  views: ProjectTestView[];
  saveView: (view: ProjectTestView) => void;
  removeView: (id: string) => void;
  sharedSteps: ProjectTestSharedStep[];
  saveSharedStep: (step: ProjectTestSharedStep) => Promise<unknown>;
  removeSharedStep: (id: string) => Promise<unknown>;
  environments: ProjectTestEnvironment[];
  removeEnvironment: (id: string, force?: boolean) => Promise<unknown>;
  schema: ProjectTestSchema;
  saveSchema: (schema: ProjectTestSchema) => Promise<unknown>;
  /**
   * Файлы обвязки, которые не прочитались. Пусто в обычном случае; непустой
   * список означает, что часть настроек показывать НЕ на чем, и окно говорит
   * об этом вместо тихого «ничего не заведено».
   */
  libraryIssues: ProjectTestLibraryIssue[];
  /** Планы проекта — окну настроек, чтобы назвать тех, кто ссылается на окружение. */
  plans: ProjectTestPlan[];
  /** Идущий или последний прогон — по нему рисуется пульт. */
  run?: ProjectTestRun;
  isBusy: boolean;
  error?: string;
  start: (payload: StartTestRunPayload) => void;
  stop: () => void;
  saveCase: (groupId: string, testCase: ProjectTestCaseInput) => Promise<unknown>;
  removeCase: (groupId: string, caseId: string) => void;
  bulk: (payload: ProjectTestBulkInput) => Promise<unknown>;
  addGroup: (id: string, title?: string) => Promise<unknown>;
  removeGroup: (id: string) => void;
  saveEnvironment: (environment: ProjectTestEnvironment) => Promise<unknown>;
  /** Знает ли о кейсах обычный разговор — то есть вписаны ли они в CLAUDE.md. */
  hasConvention: boolean;
  installConvention: () => void;
  branch?: string;
  /** Черновики генерации строкой: по ним рисуется плашка «предложения ждут». */
  drafts: ProjectTestDraftSummary[];
  /** Непринятый черновик — тот, ради которого человек сюда и вернулся. */
  pendingDraft?: ProjectTestDraftSummary;
  /** Галочка «принимать сразу»: одно положение на проект, помнит сервер. */
  autoAcceptDrafts: boolean;
  setAutoAcceptDrafts: (enabled: boolean) => void;
  /** «У меня N минут»: отметить видимые кейсы под бюджет по убыванию риска. */
  pickBudget: (minutes: number) => void;
  /** Итог последнего набора — пока его не сбросили сменой отбора или группы. */
  budget?: TestsBudget;
}

/** Что вышло у «у меня N минут»: сколько взято и что не влезло. */
export interface TestsBudget {
  budget: number;
  minutes: number;
  picked: number;
  /** Невлезшее — с названиями: это и есть ответ на «а что я не проверю». */
  left: { title: string; duration: number }[];
}

const EMPTY_SCHEMA: ProjectTestSchema = { attributes: [], statuses: [] };

/**
 * Открытая группа: выбранная человеком, а если её не стало — первая.
 *
 * Группы может не стать: агент удалил файл, или окно открыли впервые. Пустой
 * экран без вкладок читается как «тестов нет», хотя они есть.
 */
export function pickActive(
  groups: ProjectTestGroup[],
  activeId: string,
): ProjectTestGroup | undefined {
  return groups.find((group) => group.id === activeId) ?? groups[0];
}

/** Отметить или снять кейс: отметки — набор, а не список, повторов в нём нет. */
export function toggleChecked(checked: string[], id: string): string[] {
  return checked.includes(id) ? checked.filter((item) => item !== id) : [...checked, id];
}

/** Текст ошибки любой из мутаций — одной строкой, как её показывает окно. */
export function messageOf(error: unknown): string | undefined {
  if (!error) return undefined;
  const response = (error as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? (error as Error).message;
}

export function useTestsBoard(projectPath: string | undefined, isOpen: boolean): TestsBoard {
  const tests = useProjectTests(projectPath, isOpen);
  const groups = useMemo(() => tests.data?.groups ?? [], [tests.data]);

  const [activeId, setActiveId] = useState('');
  const [checked, setChecked] = useState<string[]>([]);

  const active = pickActive(groups, activeId);
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  // Замечания линтера спрашиваем один раз на раздел: их читает и карточка
  // здоровья, и отбор «с замечаниями», и это один и тот же ответ.
  const lint = useTestLint(projectPath, isOpen);
  const findingIds = useMemo(
    () => new Set((lint.data?.findings ?? []).map((item) => `${item.groupId}:${item.caseId}`)),
    [lint.data],
  );

  // Риск спрашиваем тем же одним запросом на раздел: по нему и сортируют
  // список, и набирают бюджет, и оба ответа обязаны быть одним числом.
  const risk = useTestRisk(projectPath, isOpen);
  const riskItems = useMemo(
    () => new Map((risk.data?.items ?? []).map((item) => [item.key, item])),
    [risk.data],
  );

  const filters = useTestFilters(groups, active?.id, findingIds, riskItems);
  const [budget, setBudget] = useState<TestsBudget | undefined>();

  // Итог набора описывает ТОТ отбор, на котором его считали: сменился фильтр —
  // сменился и список, а строка «не влезло 3» продолжала бы говорить о прежнем.
  useEffect(() => setBudget(undefined), [filters.filter, filters.withFindings]);

  const create = useCreateTestGroup(projectPath);
  const drop = useRemoveTestGroup(projectPath);
  const save = useSaveTestCase(projectPath);
  const erase = useRemoveTestCase(projectPath);
  const bulk = useBulkTestCases(projectPath);
  const start = useStartTestRun(projectPath);
  const stop = useStopTestRun(projectPath);
  const convention = useInstallTestConvention(projectPath);
  const saveView = useSaveTestView(projectPath);
  const dropView = useRemoveTestView(projectPath);
  const saveEnvironment = useSaveTestEnvironment(projectPath);
  const dropEnvironment = useRemoveTestEnvironment(projectPath);
  const saveStep = useSaveSharedStep(projectPath);
  const dropStep = useRemoveSharedStep(projectPath);
  const schemaSave = useSaveTestSchema(projectPath);
  const autoAccept = useSetTestDraftAuto(projectPath);

  const drafts = useMemo(() => tests.data?.drafts ?? [], [tests.data]);

  const select = (id: string): void => {
    setActiveId(id);
    setChecked([]);
    // Итог набора относится к прежней вкладке: оставить его здесь значило бы
    // показывать «не влезло 3» про кейсы, которых на экране больше нет.
    setBudget(undefined);
  };

  /**
   * «У меня N минут»: отметить то, что успеется, и вслух назвать остальное.
   *
   * Считается по ВИДИМОМУ отбору, а не по всей библиотеке: человек уже сузил
   * список фильтром, и бюджет обязан отвечать про то, на что он смотрит. Порядок
   * — по риску, независимо от того, как список отсортирован на экране: «что
   * успею» и «в каком порядке читать» — разные вопросы.
   */
  const pickBudget = (minutes: number): void => {
    const rows = [...filters.filtered].sort(
      (left, right) =>
        (riskItems.get(`${right.groupId}:${right.testCase.id}`)?.score ?? -1) -
        (riskItems.get(`${left.groupId}:${left.testCase.id}`)?.score ?? -1),
    );
    const fit = pickWithinBudget(
      rows.map((item) => ({
        key: item.testCase.id,
        title: item.testCase.title,
        duration: caseDuration(item.testCase.duration),
      })),
      minutes,
    );

    setChecked(fit.picked.map((item) => item.key));
    setBudget({
      budget: minutes,
      minutes: fit.minutes,
      picked: fit.picked.length,
      left: fit.left.map((item) => ({ title: item.title, duration: item.duration })),
    });
  };

  return {
    isLoading: tests.isLoading,
    path: projectPath,
    dir: tests.data?.dir ?? '.agent/tests',
    groups,
    active,
    activeId: active?.id ?? '',
    select,
    checked,
    toggleCase: (id) => setChecked((current) => toggleChecked(current, id)),
    // «Выбрать все» — это все ВИДИМЫЕ кейсы, а не все существующие: отбор на
    // экране и есть то, что человек имеет в виду под «все».
    checkAll: () => setChecked(filters.filtered.map((item) => item.testCase.id)),
    clearChecked: () => {
      setChecked([]);
      setBudget(undefined);
    },
    filters,
    views: tests.data?.views ?? [],
    saveView: (view) => saveView.mutate(view),
    removeView: (id) => dropView.mutate(id),
    sharedSteps: tests.data?.sharedSteps ?? [],
    saveSharedStep: (step) => saveStep.mutateAsync(step),
    removeSharedStep: (id) => dropStep.mutateAsync(id),
    environments: tests.data?.environments ?? [],
    removeEnvironment: (id, force) => dropEnvironment.mutateAsync({ id, force }),
    schema: tests.data?.schema ?? EMPTY_SCHEMA,
    saveSchema: (schema) => schemaSave.mutateAsync(schema),
    libraryIssues: tests.data?.libraryIssues ?? [],
    plans: tests.data?.plans ?? [],
    run: tests.data?.run,
    isBusy: create.isPending || drop.isPending || save.isPending || start.isPending,
    error: messageOf(
      create.error ??
        drop.error ??
        save.error ??
        erase.error ??
        bulk.error ??
        start.error ??
        stop.error,
    ),
    start: (payload) => {
      setChecked([]);
      start.mutate(payload);
    },
    stop: () => stop.mutate(undefined as never),
    saveCase: (groupId, testCase) => save.mutateAsync({ groupId, testCase }),
    removeCase: (groupId, caseId) => erase.mutate({ groupId, caseId }),
    bulk: async (payload) => {
      const result = await bulk.mutateAsync(payload);
      setChecked([]);
      return result;
    },
    addGroup: (id, title) => create.mutateAsync({ id, title }),
    removeGroup: (id) => drop.mutate(id),
    saveEnvironment: (environment) => saveEnvironment.mutateAsync(environment),
    hasConvention: tests.data?.hasConvention ?? false,
    installConvention: () => convention.mutate(undefined as never),
    branch: tests.data?.branch,
    drafts,
    pendingDraft: drafts.find((item) => item.status === 'pending'),
    autoAcceptDrafts: tests.data?.autoAcceptDrafts ?? false,
    setAutoAcceptDrafts: (enabled) => autoAccept.mutate(enabled),
    pickBudget,
    budget,
  };
}
