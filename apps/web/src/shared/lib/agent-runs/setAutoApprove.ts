import { apiClient } from '@shared/api/client';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { getRun } from './getRun';

/**
 * Переключить автоподтверждение прав у идущего прогона. Без этого новое
 * положение тумблера подействовало бы только со следующего сообщения — а
 * щёлкают его как раз посреди прогона, устав жать «Разрешить».
 */
export function setAutoApprove(id: string, enabled: boolean): void {
  const run = getRun(id);
  const key = run.id || id;
  if (!key) return;
  const current = runs.get(key);
  if (current) {
    runs.set(key, { ...current, autoApprove: enabled });
    emit();
  }
  if (run.status !== 'running') return;
  // Прогон мог быть заведён другой вкладкой под своим ключом (serverRunId) —
  // тумблер должен дойти именно до него, как и остановка.
  const target = current?.serverRunId ?? key;
  void apiClient.post(`/chat/${target}/auto-approve`, { enabled }).catch(() => undefined);
}
