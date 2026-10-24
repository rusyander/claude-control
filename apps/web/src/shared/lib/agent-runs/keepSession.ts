import { apiClient } from '@shared/api/client';
import { toErrorMessage } from '../../api/toErrorMessage';
import { emit } from './emit';
import { findKey } from './findKey';
import { resumeActive } from './resumeActive';
import { runs } from './agent-runs.state.constants';

/** Через сколько подхватить ход старой сессии: прежний поток к этому времени закрыт. */
const PICKUP_MS = 400;

/**
 * «Продолжить старый разговор» на заметке остывшей сессии (R5): сервер снимает
 * новый разговор и сам начинает тот же ход старой сессией. Своего старта у
 * вкладки нет — новый ход подхватывает `resumeActive` как ход, начатый не ею
 * (закрытый прежний, более поздний `startedAt`). Отказ сервера — строкой
 * ошибки прогона, его словами.
 */
export async function keepSession(id: string): Promise<boolean> {
  const key = findKey(id) ?? id;
  const target = runs.get(key)?.serverRunId ?? key;
  try {
    await apiClient.post(`/chat/${encodeURIComponent(target)}/keep-session`);
  } catch (error) {
    const run = runs.get(key);
    if (run) {
      runs.set(key, { ...run, error: toErrorMessage(error) });
      emit();
    }
    return false;
  }
  setTimeout(() => void resumeActive(), PICKUP_MS);
  return true;
}
