import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import type { CommandKind } from '@agentdeck/contracts/core/commands';
import type { EstimateFields, EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import type { TaskReply } from '@agentdeck/contracts/core/panel-api';
import {
  type CommandDraft,
  type CoreFailure,
  coreGet,
  failureOf,
  failureOfOutcome,
  failureReason,
  newUuidv7,
  sendCoreCommand,
  useCoreCommand,
  useCoreTaskEvents,
  useCoreTaskView,
} from '@entities/CoreTask';
import type { ReviewLinkRefused } from '@agentdeck/contracts/core/review-link';
import { postEstimate, postReviewLink } from '../api/launchApi';
import type { EstimateAttempt, LaunchFold, UnitDraft } from './launch.types';
import { type GroupLaunchRow, type GroupSendResult, launchGroup } from './groupLaunch';
import { useGroupIntake } from './useGroupIntake';
import { attemptFor } from './launchDraft';
import { reviewAttemptFor, reviewLinkRefusalOf, type ReviewLinkFields } from './reviewLinkDraft';
import {
  EMPTY_FOLD,
  foldLaunchLine,
  grantKey,
  launchBlockers,
  launchCommand,
  lineOfEvent,
} from './launchFold';
import { draftOfSplit, editSplitFields, splitDirty, splitProblems } from './splitDraft';

/**
 * Ответа нет вовсе (сеть, ядро не ответило): дошёл ли запрос, неизвестно — ключ повтора держим,
 * повтор вернёт ту же задачу. Ядро ответило отказом — ключ сброшен: исправленный черновик уйдёт
 * новой попыткой, а не воскресит отказанную.
 */
const KEEP_ATTEMPT = new Set<CoreFailure['kind']>(['network', 'refusal']);

/** Какая команда сейчас в полёте: кнопка именно её показывает загрузку. */
export type Busy = 'grant' | 'edit-split' | 'launch' | null;

/**
 * Ход экрана запуска: оценка → ответ (дороги, правки, слой, гранты) → поток задачи (деление,
 * выданные гранты, состояние) → правка деления → подтверждение грантов → запуск. Всё, что решает
 * «можно ли запускать», считается моделью (`launchBlockers`), а не кнопками.
 */
export function useLaunchFlow() {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<EstimateAttempt | null>(null);
  const [reply, setReply] = useState<EstimateReply | null>(null);
  const [failure, setFailure] = useState<CoreFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [fold, setFold] = useState<LaunchFold>(EMPTY_FOLD);
  const [edit, setEdit] = useState<{ seq: number; units: UnitDraft[] } | null>(null);
  const [commandFailure, setCommandFailure] = useState<CoreFailure | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const [reviewAttempt, setReviewAttempt] = useState<EstimateAttempt | null>(null);
  const [reviewRefusal, setReviewRefusal] = useState<ReviewLinkRefused | null>(null);
  const [groupRows, setGroupRows] = useState<GroupLaunchRow[] | null>(null);
  // Ключи команд запуска группы между нажатиями: повтор после частичного отказа — тем же `cmdId`.
  const groupCmdIds = useRef(new Map<string, string>());

  const taskId = reply?.taskId;
  const groupIds = reply?.group?.taskIds ?? [];
  const grouped = groupIds.length > 1;
  // Карточки приёма группы — одной кнопкой, пока группа не запущена (ведущий спрашивает каждую).
  const intake = useGroupIntake(grouped ? groupIds : [], grouped && !launched);
  const stream = useCoreTaskEvents(taskId, (event) =>
    setFold((f) => foldLaunchLine(f, lineOfEvent(event))),
  );
  const { view } = useCoreTaskView(taskId);
  const command = useCoreCommand();

  const split = fold.split;
  // Ключи строк редактора выдаются один раз на предложение, а не на каждую перерисовку.
  const proposed = useMemo(() => (split ? draftOfSplit(split) : null), [split]);
  const units = split && edit && edit.seq === split.seq ? edit.units : proposed;
  const dirty = splitDirty(units, split);

  /** Ответ оценки или открытия ревью — задача есть: дальше один и тот же ход экрана. */
  const accept = (got: EstimateReply) => {
    if (got.taskId !== taskId) {
      setFold(EMPTY_FOLD);
      setEdit(null);
      setLaunched(false);
      setCommandFailure(null);
      setGroupRows(null);
      groupCmdIds.current = new Map();
      intake.reset();
    }
    setReply(got);
    // Оценка создала задачу (G5): список задач рядом с запуском (страница групп, `/core`)
    // иначе показывал бы «задач нет» до перезагрузки.
    void queryClient.invalidateQueries({ queryKey: queryKeys.core.tasks });
  };

  const estimate = async (fields: EstimateFields) => {
    const next = attemptFor(attempt, fields);
    setAttempt(next);
    setPending(true);
    setFailure(null);
    setReviewRefusal(null);
    try {
      accept(await postEstimate(next.cmdId, fields));
      setAttempt(null);
    } catch (error) {
      const why = failureOf(error);
      setFailure(why);
      if (!KEEP_ATTEMPT.has(why.kind)) setAttempt(null);
    } finally {
      setPending(false);
    }
  };

  /**
   * Ревью MR по ссылке (этап 10, F8): тот же ответ, что у оценки, свой ключ повтора. Отказ с кодом
   * `review_link_*` — своя карточка (текст по коду), остальное — общий разбор отказа.
   */
  const reviewLink = async (fields: ReviewLinkFields) => {
    const next = reviewAttemptFor(reviewAttempt, fields);
    setReviewAttempt(next);
    setPending(true);
    setFailure(null);
    setReviewRefusal(null);
    try {
      accept(await postReviewLink(next.cmdId, fields));
      setReviewAttempt(null);
    } catch (error) {
      const refused = reviewLinkRefusalOf(error);
      if (refused) {
        setReviewRefusal(refused);
        setReviewAttempt(null);
        return;
      }
      const why = failureOf(error);
      setFailure(why);
      if (!KEEP_ATTEMPT.has(why.kind)) setReviewAttempt(null);
    } finally {
      setPending(false);
    }
  };

  const send = async (
    kind: CommandKind,
    fields: CommandDraft['fields'],
    mark: Busy,
  ): Promise<boolean> => {
    if (!taskId) return false;
    setBusy(mark);
    setCommandFailure(null);
    try {
      const outcome = await command.mutateAsync({ kind, taskId, fields });
      const why = failureOfOutcome(outcome);
      setCommandFailure(why);
      return why === null;
    } catch (error) {
      setCommandFailure(failureOf(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Подтверждение гранта — команда `grant`; подтверждённым его делает строка журнала, не ответ. */
  const confirmGrant = async (grant: GrantConfirmation) => {
    setGranting(grantKey(grant));
    await send('grant', { project: grant.repoKey, globs: grant.globs, ops: grant.ops }, 'grant');
    setGranting(null);
  };

  const saveSplit = async () => {
    if (!split || !units || splitProblems(units).length > 0) return;
    const fields = editSplitFields(split.splitId, units);
    await send('edit-split', fields as unknown as CommandDraft['fields'], 'edit-split');
  };

  const taskBlockers = reply
    ? launchBlockers({ reply, fold, viewState: view?.state ?? null, splitDirty: dirty })
    : [];
  const launchWith = launchCommand(fold);
  // Группа: запущенная задача 0 не закрывает кнопку — остальные задачи ещё могут ждать запуска.
  const blockers = grouped ? taskBlockers.filter((b) => b !== 'launched') : taskBlockers;
  const canLaunch = grouped
    ? blockers.length === 0 && !launched
    : launchWith !== null && blockers.length === 0;

  const sendGroupCommand = async (
    id: string,
    next: { kind: CommandKind; fields: CommandDraft['fields'] },
    cmdId: string,
  ): Promise<GroupSendResult> => {
    try {
      const why = failureOfOutcome(await sendCoreCommand({ ...next, taskId: id, cmdId }));
      return why === null ? { ok: true } : { ok: false, reason: failureReason(why), keep: false };
    } catch (error) {
      const why = failureOf(error);
      return { ok: false, reason: failureReason(why), keep: KEEP_ATTEMPT.has(why.kind) };
    }
  };

  /** Группа: каждая задача — та же команда запуска, по очереди; отказ одной не держит остальные. */
  const launchAllOfGroup = async () => {
    setBusy('launch');
    setCommandFailure(null);
    try {
      const rows = await launchGroup(
        groupIds,
        {
          view: async (id) => (await coreGet<TaskReply>('/tasks/:id', { id })).view ?? null,
          send: (id, next, cmdId) => sendGroupCommand(id, next, cmdId),
          newId: () => newUuidv7(),
        },
        groupCmdIds.current,
      );
      setGroupRows(rows);
      if (rows.every((r) => r.status === 'started')) setLaunched(true);
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.core.tasks });
      for (const id of groupIds)
        void queryClient.invalidateQueries({ queryKey: queryKeys.core.task(id) });
    }
  };

  const launch = async () => {
    if (!canLaunch) return;
    if (grouped) return launchAllOfGroup();
    if (!launchWith) return;
    if (await send(launchWith.kind, launchWith.fields, 'launch')) setLaunched(true);
  };

  return {
    reply,
    failure,
    pending,
    retrying: attempt !== null && failure !== null,
    estimate,
    reviewLink,
    reviewRefusal,
    reviewRetrying: reviewAttempt !== null && failure !== null,
    fold,
    stream,
    viewState: view?.state ?? null,
    units,
    dirty,
    setUnits: (next: UnitDraft[]) => {
      if (split) setEdit({ seq: split.seq, units: next });
    },
    resetSplit: () => setEdit(null),
    saveSplit,
    confirmGrant,
    granting,
    blockers,
    /** Задача 0 отказана или уже идёт: её деление и гранты только для чтения (группа — тоже). */
    closed: taskBlockers.includes('refused') || taskBlockers.includes('launched'),
    canLaunch,
    launch,
    launched,
    /** Группа: сколько задач запускает кнопка (`0` — одиночная задача). */
    groupSize: grouped ? groupIds.length : 0,
    groupRows,
    /** Группа: подтверждение карточек приёма всех задач одной кнопкой. */
    intake,
    busy,
    commandFailure,
  };
}

export type LaunchFlow = ReturnType<typeof useLaunchFlow>;
