import type { PathEntry, KnobView } from '@agentdeck/contracts';

/**
 * Строка вкладки «Порядок работы». Почти всегда — строка пути с сервера; но у
 * скилла-участника с настраиваемыми числами и без пронумерованных шагов в пути
 * нет ни одной строки, и его числам негде было бы стоять. Такой скилл получает
 * свою строку «скилл целиком» — там же, где сервер ставит шаги скиллов: после
 * стадии работы.
 */
export type PathRow =
  | {
      kind: 'entry';
      key: string;
      entry: PathEntry;
      /** Индекс в `entries` — «+» после строки вставляет шаг после него. */
      entryIndex: number;
      knobs: KnobView[];
    }
  | { kind: 'skill'; key: string; skillId: string; entryIndex: number; knobs: KnobView[] };
