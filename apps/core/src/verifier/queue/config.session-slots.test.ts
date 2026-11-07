import { describe, expect, it } from 'vitest';
import { parseCoreConfig } from '../../platform/core-config/read.ts';
import { queueSectionOf } from './config.ts';
import { DEFAULT_QUEUE_CONFIG } from './order.ts';

/**
 * `queue.sessionSlots` (этап 11, P141) — поле раздела `queue` наравне с прочими: годное значение
 * доходит до распределителя мест, негодное отвергается одно, не роняя весь раздел на прежние
 * значения. Настоящие единый читатель настройки и разбор раздела очереди; файла нет.
 */

function section(text: string) {
  const read = parseCoreConfig(text);
  if (!('value' in read)) throw new Error('config text not read');
  return queueSectionOf(read.value, DEFAULT_QUEUE_CONFIG);
}

describe('queue.sessionSlots in the queue section', () => {
  it('a valid sessionSlots reaches the queue config', () => {
    const got = section('{"queue":{"slots":1,"sessionSlots":3}}');
    expect(got.issues).toEqual([]);
    expect(got.config).toEqual({ ...DEFAULT_QUEUE_CONFIG, slots: 1, sessionSlots: 3 });
  });

  it('a sessionSlots above the limit is rejected alone: slots of the same section still apply', () => {
    // Предел — 6 (`LEAD_PARALLELISM_MAX`); 99 вне его.
    const got = section('{"queue":{"slots":1,"sessionSlots":99}}');
    expect(got.issues).toEqual(['queue.sessionSlots: 99 rejected']);
    expect(got.config.slots).toBe(1);
    expect(got.config.sessionSlots).toBeUndefined();
  });
});
