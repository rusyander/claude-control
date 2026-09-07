import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectTestBulkInput,
  ProjectTestCaseInput,
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestRun,
  ProjectTestSchema,
  ProjectTestSharedStep,
  ProjectTestView,
} from '@agentdeck/contracts';
import {
  useBulkTestCases,
  useCreateTestGroup,
  useInstallTestConvention,
  useProjectTests,
  useRemoveTestCase,
  useRemoveTestGroup,
  useRemoveTestView,
  useSaveTestCase,
  useSaveTestEnvironment,
  useSaveTestView,
  useStartTestRun,
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
  environments: ProjectTestEnvironment[];
  schema: ProjectTestSchema;
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
  saveEnvironment: (environment: ProjectTestEnvironment) => void;
  /** Знает ли о кейсах обычный разговор — то есть вписаны ли они в CLAUDE.md. */
  hasConvention: boolean;
  installConvention: () => void;
  branch?: string;
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

  const filters = useTestFilters(groups, active?.id);

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

  const select = (id: string): void => {
    setActiveId(id);
    setChecked([]);
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
    clearChecked: () => setChecked([]),
    filters,
    views: tests.data?.views ?? [],
    saveView: (view) => saveView.mutate(view),
    removeView: (id) => dropView.mutate(id),
    sharedSteps: tests.data?.sharedSteps ?? [],
    environments: tests.data?.environments ?? [],
    schema: tests.data?.schema ?? EMPTY_SCHEMA,
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
    saveEnvironment: (environment) => saveEnvironment.mutate(environment),
    hasConvention: tests.data?.hasConvention ?? false,
    installConvention: () => convention.mutate(undefined as never),
    branch: tests.data?.branch,
  };
}
