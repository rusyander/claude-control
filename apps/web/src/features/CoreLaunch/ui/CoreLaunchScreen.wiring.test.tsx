import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { LaunchFlow } from '../model/useLaunchFlow';

// Ход экрана — свой хук со своими тестами (`useLaunchFlow.group.test.ts`); здесь он отдаёт готовое
// состояние группы, а проверяется, что экран передаёт карточкам.
const confirm = vi.fn(async () => {});
let flow: Partial<LaunchFlow>;
vi.mock('../model/useLaunchFlow', () => ({ useLaunchFlow: () => flow }));

const { CoreLaunchScreen } = await import('./CoreLaunchScreen');
const { EstimateCard } = await import('./EstimateCard/EstimateCard');
const { GrantsCard } = await import('./GrantsCard/GrantsCard');
const { SplitEditor } = await import('./SplitEditor/SplitEditor');
const { LaunchCard } = await import('./LaunchCard/LaunchCard');

/** Свойства первого элемента этого типа в дереве экрана. */
function propsOf(node: ReactNode, type: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child as ReactNode, type);
      if (found) return found;
    }
    return undefined;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element.props;
  return propsOf(element.props.children as ReactNode, type);
}

const GROUP_ROWS = [{ taskId: 't1', status: 'started' as const }];

/**
 * Экран запуска группы (этап 11): кнопка знает размер группы и строки её запуска, карточки приёма
 * подтверждаются одной кнопкой; задача 0 уже идёт — её деление и гранты только для чтения, даже
 * когда кнопка группы ещё открыта; «Настроить для этого проекта» на оценке — область ведения.
 */
describe('CoreLaunchScreen — группа и ведение', () => {
  it('передаёт карточкам состояние группы, закрытость задачи 0 и проект оценки', () => {
    const onLeadScope = vi.fn();
    flow = {
      reply: {
        taskId: 't0',
        preflight: [],
        grants: [],
        overlay: { rejected: [] },
        userLayer: null,
      } as never,
      fold: {
        split: null,
        grantsGiven: [],
        state: null,
        repoKeys: ['repo-a', 'repo-b'],
        lastSeq: 1,
      },
      blockers: [],
      closed: true,
      canLaunch: true,
      busy: null,
      launched: false,
      groupSize: 3,
      groupRows: GROUP_ROWS,
      intake: { pending: 2, classWaiting: 1, rows: null, busy: false, confirm } as never,
      failure: null,
      commandFailure: null,
    };
    const tree = CoreLaunchScreen({ onLeadScope });

    expect(propsOf(tree, EstimateCard)).toMatchObject({ repoKey: 'repo-a', onLeadScope });
    expect(propsOf(tree, GrantsCard)?.closed).toBe(true);
    expect(propsOf(tree, SplitEditor)?.readOnly).toBe(true);
    const launch = propsOf(tree, LaunchCard);
    expect(launch).toMatchObject({ groupSize: 3, groupRows: GROUP_ROWS, canLaunch: true });
    const intake = launch?.intake as {
      pending: number;
      classWaiting: number;
      onConfirm: () => void;
    };
    expect([intake.pending, intake.classWaiting]).toEqual([2, 1]);
    intake.onConfirm();
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
