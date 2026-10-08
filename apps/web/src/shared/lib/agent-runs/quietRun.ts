import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/**
 * Спрятать потоковый текст прогона, сохранив статус: когда ответ уже есть в
 * истории, дубль на экране не нужен, но жёлтая/красная точка (вопрос/ошибка)
 * должна остаться.
 *
 * Здесь же снимается метка потерянного потока: она говорит «ответ ищите в
 * переписке», а переписка только что показана — дальше это была бы строка о
 * беде, которой уже нет.
 */
export function quietRun(id: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run) return;
  runs.set(key, { ...run, text: '', thinking: '', tools: [], dropped: undefined });
  emit();
}
