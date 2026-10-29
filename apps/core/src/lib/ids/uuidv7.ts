import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 ядра (RFC 9562 §5.7): 48 бит миллисекунд, затем 12 бит счётчика внутри миллисекунды,
 * затем 62 бита случайности. Счётчик держит порядок: два id одной миллисекунды сортируются в
 * порядке выдачи, поэтому id из журнала можно сравнивать строкой (P49: одна форма на сущность).
 *
 * Часы инъецируются только ради теста; в ядре — `Date.now`, и время в id не служит временем
 * события: время события ставит лишь `journal.append` (P09).
 */
export interface IdSource {
  next(): string;
}

export function createIdSource(
  now: () => number = Date.now,
  random: (n: number) => Buffer = randomBytes,
): IdSource {
  let lastMs = -1;
  let counter = 0;
  return {
    next(): string {
      let ms = now();
      if (ms <= lastMs) {
        // Часы стоят или ушли назад — продолжаем от последней миллисекунды, счётчик растёт.
        ms = lastMs;
        counter += 1;
        if (counter > 0xfff) {
          ms = lastMs + 1;
          counter = 0;
        }
      } else {
        counter = 0;
      }
      lastMs = ms;
      const bytes = random(16);
      bytes.writeUIntBE(ms, 0, 6);
      bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
      bytes[7] = counter & 0xff;
      bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
      const hex = bytes.toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}

const shared = createIdSource();

/** Новый id сущности ядра. Выдаётся до любого запуска — временных ключей нет. */
export function newId(): string {
  return shared.next();
}
