import { rebuildStatuses } from './agent-runs.statuses';
import { apiClient } from '@shared/api/client';
import { signatureRefusalText } from '@shared/api/signatureRefusal';
import { permissionDeliveryProblem } from './permissionDelivery';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { getRun } from './getRun';
import type { PendingPermission } from './agent-runs.types';

/** Ответить на запрос прав (клик «Разрешить»/«Запретить»). */
export function decidePermission(
  id: string,
  toolUseId: string,
  behavior: 'allow' | 'deny',
  message?: string,
): void {
  const run = getRun(id);
  const key = run.id || id;
  // Локально убираем карточку сразу — не ждём эха с сервера.
  const current = runs.get(key);
  const removed = current?.permissions.find((p) => p.toolUseId === toolUseId);
  const removedDeferred = current?.deferredPermissions?.find((p) => p.toolUseId === toolUseId);
  if (current) {
    runs.set(key, {
      ...current,
      permissions: current.permissions.filter((p) => p.toolUseId !== toolUseId),
      // Отложенная карточка отвечается тем же маршрутом: сервер решает её D-n.
      deferredPermissions: current.deferredPermissions?.filter((p) => p.toolUseId !== toolUseId),
    });
    rebuildStatuses();
    emit();
  }
  // …но если решение до брокера не дошло, об этом надо сказать: карточки уже
  // нет, а агент всё ещё стоит и ждёт — молчание здесь выглядит как «ответил».
  const target = current?.serverRunId ?? key;
  void apiClient
    .post(`/chat/${target}/permission-decision`, { toolUseId, behavior, message })
    .then(({ data }) => permissionDeliveryProblem(data as { ok?: unknown }))
    .catch((error: unknown) => {
      // Режим подписи телефона не принял «Разрешить» из окна: вызов ждёт, и
      // карточка возвращается — «Запретить» с неё по-прежнему проходит.
      const refusal = signatureRefusalText(error);
      if (refusal !== undefined) {
        restoreCard(key, removed, removedDeferred);
        toast.error(refusal);
        return undefined;
      }
      return permissionDeliveryProblem(undefined, error ?? 'network');
    })
    .then((problem) => {
      if (problem) toast.error(i18n.t(problem));
    });
}

/** Вернуть снятую карточку, если её ещё нет (эхо сервера могло вернуть раньше). */
function restoreCard(
  key: string,
  permission: PendingPermission | undefined,
  deferred: PendingPermission | undefined,
): void {
  const run = runs.get(key);
  if (!run || (!permission && !deferred)) return;
  const missing = (list: PendingPermission[] | undefined, item: PendingPermission) =>
    !list?.some((p) => p.toolUseId === item.toolUseId);
  runs.set(key, {
    ...run,
    permissions:
      permission && missing(run.permissions, permission)
        ? [...run.permissions, permission]
        : run.permissions,
    ...(deferred && missing(run.deferredPermissions, deferred)
      ? { deferredPermissions: [...(run.deferredPermissions ?? []), deferred] }
      : {}),
  });
  rebuildStatuses();
  emit();
}
