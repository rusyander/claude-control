import { rebuildStatuses } from './agent-runs.statuses';
import { apiClient } from '@shared/api/client';
import { permissionDeliveryProblem } from './permissionDelivery';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { getRun } from './getRun';

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
  if (current) {
    runs.set(key, {
      ...current,
      permissions: current.permissions.filter((p) => p.toolUseId !== toolUseId),
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
    .catch((error: unknown) => permissionDeliveryProblem(undefined, error ?? 'network'))
    .then((problem) => {
      if (problem) toast.error(i18n.t(problem));
    });
}
