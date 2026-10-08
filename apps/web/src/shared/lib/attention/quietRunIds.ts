import type { ActiveRunView } from '@shared/lib/agent-runs';
import { callsForAttention } from './attention';

/**
 * Прогоны, чей прошлый повод пора забыть: прогон жив и больше не зовёт. Тогда
 * следующее «ждёт» у него — уже новый повод (ключ по статусу совпал бы со
 * старым, увиденным). Отсутствующий прогон не трогаем: до его подхвата после
 * перезагрузки список пуст, и забытое снова звало бы.
 */
export function quietRunIds(runs: readonly ActiveRunView[]): string[] {
  return runs.filter((run) => !callsForAttention(run.status)).map((run) => run.id);
}
