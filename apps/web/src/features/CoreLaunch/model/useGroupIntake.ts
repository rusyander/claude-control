import { useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TaskReply } from '@agentdeck/contracts/core/panel-api';
import { queryKeys } from '@shared/api/query-keys';
import {
  coreGet,
  failureOf,
  failureOfOutcome,
  failureReason,
  newUuidv7,
  sendCoreCommand,
  type CoreFailure,
} from '@entities/CoreTask';
import {
  classWaitingOf,
  confirmGroupIntake,
  type GroupIntakeRow,
  type IntakeSendResult,
  pendingIntakeCount,
} from './groupIntake';

/** Ответа нет вовсе (сеть): дошёл ли ответ, неизвестно — ключ держим, повтор вернёт тот же исход. */
const KEEP = new Set<CoreFailure['kind']>(['network', 'refusal']);

/**
 * Вид задач группы перечитывается, пока экран ждёт карточек: вопросы приёма поднимаются шагом
 * разбора каждой задачи, ленты остальных задач экран запуска не слушает.
 */
const VIEWS_REFRESH_MS = 1500;

/**
 * Подтверждение карточек группы одной кнопкой (этап 11, W3-18). `active` — группа ещё не
 * запущена: после запуска виды не перечитываются. Ключи ответов живут между нажатиями и
 * сбрасываются вместе с группой (`reset`).
 */
export function useGroupIntake(taskIds: readonly string[], active: boolean) {
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const [rows, setRows] = useState<GroupIntakeRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const cmdIds = useRef(new Map<string, string>());
  const views = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: queryKeys.core.task(id),
      queryFn: () => coreGet<TaskReply>('/tasks/:id', { id }),
      enabled: active,
      refetchInterval: active ? VIEWS_REFRESH_MS : (false as const),
      retry: false,
    })),
  });
  const pairs = views.map((v, i) => [taskIds[i] ?? '', v.data?.view] as const);
  const pending = pendingIntakeCount(pairs);
  const classWaiting = classWaitingOf(pairs);

  const send = async (
    taskId: string,
    fields: { askId: string; answer: string },
    cmdId: string,
  ): Promise<IntakeSendResult> => {
    try {
      const why = failureOfOutcome(
        await sendCoreCommand({ kind: 'answer', taskId, fields, cmdId }),
      );
      return why === null ? { ok: true } : { ok: false, reason: failureReason(why), keep: false };
    } catch (error) {
      const why = failureOf(error);
      return { ok: false, reason: failureReason(why), keep: KEEP.has(why.kind) };
    }
  };

  /**
   * Исход показывается вместе с перечитанными видами: число на кнопке считается по видам, и строка
   * «подтверждено 3 из 3» рядом со старым видом звала бы подтвердить ещё раз уже подтверждённое.
   */
  const confirm = async () => {
    setBusy(true);
    let got: GroupIntakeRow[] | null = null;
    try {
      got = await confirmGroupIntake(
        taskIds,
        {
          view: async (id) => (await coreGet<TaskReply>('/tasks/:id', { id })).view ?? null,
          send,
          newId: () => newUuidv7(),
        },
        cmdIds.current,
        i18n.language === 'en' ? 'en' : 'ru',
      );
    } finally {
      await Promise.all(
        taskIds.map((id) => queryClient.invalidateQueries({ queryKey: queryKeys.core.task(id) })),
      );
      if (got) setRows(got);
      setBusy(false);
    }
  };

  const reset = () => {
    setRows(null);
    cmdIds.current = new Map();
  };

  return { pending, classWaiting, rows, busy, confirm, reset };
}

export type GroupIntake = ReturnType<typeof useGroupIntake>;
