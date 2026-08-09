import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectTestCaseInput,
  ProjectTestGroup,
  ProjectTestRun,
} from '@claude-control/contracts';
import {
  useCreateTestGroup,
  useInstallTestConvention,
  useProjectTests,
  useRemoveTestCase,
  useRemoveTestGroup,
  useSaveTestCase,
  useStartTestRun,
  useStopTestRun,
  type StartTestRunPayload,
} from '@entities/ProjectTest';

/**
 * Состояние окна тестов: какая группа открыта, что отмечено, что запускается.
 *
 * Выбор кейсов живёт здесь, а не в списке, потому что его читает пульт наверху
 * («Прогнать выбранные»), а сбрасывать его нужно при смене группы — иначе
 * человек запустил бы кейсы, которых уже не видит на экране.
 */
export interface TestsBoard {
  isLoading: boolean;
  dir: string;
  groups: ProjectTestGroup[];
  active?: ProjectTestGroup;
  activeId: string;
  select: (id: string) => void;
  /** Отмеченные кейсы активной группы. */
  checked: string[];
  toggleCase: (id: string) => void;
  checkAll: () => void;
  clearChecked: () => void;
  /** Идущий или последний прогон — по нему рисуется пульт. */
  run?: ProjectTestRun;
  isBusy: boolean;
  error?: string;
  start: (payload: StartTestRunPayload) => void;
  stop: () => void;
  saveCase: (groupId: string, testCase: ProjectTestCaseInput) => Promise<unknown>;
  removeCase: (groupId: string, caseId: string) => void;
  addGroup: (id: string, title?: string) => Promise<unknown>;
  removeGroup: (id: string) => void;
  /** Знает ли о кейсах обычный разговор — то есть вписаны ли они в CLAUDE.md. */
  hasConvention: boolean;
  installConvention: () => void;
}

/** Текст ошибки любой из мутаций — одной строкой, как её показывает окно. */
function messageOf(error: unknown): string | undefined {
  if (!error) return undefined;
  const response = (error as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? (error as Error).message;
}

export function useTestsBoard(projectPath: string | undefined, isOpen: boolean): TestsBoard {
  const tests = useProjectTests(projectPath, isOpen);
  const groups = useMemo(() => tests.data?.groups ?? [], [tests.data]);

  const [activeId, setActiveId] = useState('');
  const [checked, setChecked] = useState<string[]>([]);

  // Группу выбирает человек, но её может не стать: агент удалил файл, или окно
  // открыли впервые. Тогда открываем первую — пустой экран без вкладок читается
  // как «тестов нет», хотя они есть.
  const active = groups.find((group) => group.id === activeId) ?? groups[0];
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  const create = useCreateTestGroup(projectPath);
  const drop = useRemoveTestGroup(projectPath);
  const save = useSaveTestCase(projectPath);
  const erase = useRemoveTestCase(projectPath);
  const start = useStartTestRun(projectPath);
  const stop = useStopTestRun(projectPath);
  const convention = useInstallTestConvention(projectPath);

  const select = (id: string): void => {
    setActiveId(id);
    setChecked([]);
  };

  return {
    isLoading: tests.isLoading,
    dir: tests.data?.dir ?? '.agent/tests',
    groups,
    active,
    activeId: active?.id ?? '',
    select,
    checked,
    toggleCase: (id) =>
      setChecked((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
      ),
    checkAll: () => setChecked((active?.cases ?? []).map((item) => item.id)),
    clearChecked: () => setChecked([]),
    run: tests.data?.run,
    isBusy: create.isPending || drop.isPending || save.isPending || start.isPending,
    error: messageOf(
      create.error ?? drop.error ?? save.error ?? erase.error ?? start.error ?? stop.error,
    ),
    start: (payload) => {
      setChecked([]);
      start.mutate(payload);
    },
    stop: () => stop.mutate(undefined as never),
    saveCase: (groupId, testCase) => save.mutateAsync({ groupId, testCase }),
    removeCase: (groupId, caseId) => erase.mutate({ groupId, caseId }),
    addGroup: (id, title) => create.mutateAsync({ id, title }),
    removeGroup: (id) => drop.mutate(id),
    hasConvention: tests.data?.hasConvention ?? false,
    installConvention: () => convention.mutate(undefined as never),
  };
}
