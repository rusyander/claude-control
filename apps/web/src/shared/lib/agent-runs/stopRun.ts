import { controllers } from './agent-runs.state';
import { stoppedByUser, cancelAutoRetry } from './agent-runs.retry';
import { rebuildStatuses } from './agent-runs.statuses';
import { apiClient } from '@shared/api/client';
import { toErrorMessage } from '../../api/toErrorMessage';
import { finalize } from './agent-runs.lifecycle';
import { persistQueue } from './persistQueue';
import { attachRun } from './agent-runs.slots';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { findKey } from './findKey';

export function isStopUnconfirmed(error: unknown): boolean {
  const data = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data;
  return data?.code === 'stop_unconfirmed';
}

/**
 * Сервер не снял процесс (F-145): номер нечем проверить, а чужое он не трогает.
 * Прогон на сервере идёт — поток, оборванный кнопкой, подключаем заново, иначе
 * агент работал бы дальше под видом «остановлено», а лента молчала бы до F5.
 * Ждём, пока прежний поток дочитается: он закрывает ход по метке остановки, и
 * снять её раньше значило бы превратить его конец в падение с авто-рестартом.
 */
export function resumeAfterRefusedStop(key: string, id: string, message: string, tries = 0): void {
  if (!runs.has(key)) return;
  if (controllers.has(key) && tries < 100) {
    setTimeout(() => resumeAfterRefusedStop(key, id, message, tries + 1), 20);
    return;
  }
  stoppedByUser.delete(key);
  stoppedByUser.delete(id);
  // Буфер прогона отдадут заново с нулевого `seq` — набранное начинаем с чистого.
  setRun(key, {
    status: 'running',
    error: message,
    text: '',
    thinking: '',
    tools: [],
    stalled: undefined,
    dropped: undefined,
    lastEventAt: Date.now(),
    parked: true,
  });
  rebuildStatuses();
  emit();
  attachRun(key);
}

/**
 * Остановить прогон: сервер убивает процесс, клиент перестаёт читать поток.
 *
 * Снимаем и отложенный авто-рестарт — иначе через пару секунд таймер поднимет
 * агента снова, уже после нажатия «Остановить». Не подтвердил сервер остановку
 * — говорим об этом: процесс мог остаться жив, и молча писать «остановлено»
 * значит врать.
 */
export function stopRun(id: string): void {
  const key = findKey(id) ?? id;
  stoppedByUser.add(key);
  stoppedByUser.add(id);
  // Остановка гасит и очередь: человек прервал работу, а дописанное ушло бы
  // сразу после — получилось бы, что кнопка «Остановить» ничего не остановила.
  const queuedRun = runs.get(key);
  if (queuedRun && queuedRun.queued.length > 0) {
    runs.set(key, { ...queuedRun, queued: [] });
    persistQueue(key);
  }
  cancelAutoRetry(key);
  cancelAutoRetry(id);
  // Прогон мог быть заведён другой вкладкой под своим ключом (serverRunId) —
  // останавливать надо именно его, иначе сервер ответит «прогона нет», а
  // агент продолжит работать.
  const target = runs.get(key)?.serverRunId ?? key;
  void apiClient.post(`/chat/${target}/stop`).catch((error: unknown) => {
    const run = runs.get(key);
    if (!run) return;
    // Текст — словами сервера (код перевода), а не «status code 409» axios.
    const message = toErrorMessage(error);
    if (isStopUnconfirmed(error)) {
      resumeAfterRefusedStop(key, id, message);
      return;
    }
    runs.set(key, { ...run, error: message });
    emit();
  });
  const controller = controllers.get(key);
  controller?.abort();
  // Контроллера нет — прогон уже дочитан и ждал отложенного авто-рестарта.
  // Оборвать нечего, и без этого он навис бы «идущим» навсегда: поток
  // завершён, таймер только что снят, а финализировать его больше некому.
  if (!controller) finalize(key);
}
