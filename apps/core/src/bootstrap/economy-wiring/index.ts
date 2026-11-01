import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { WindowBook } from '../../economy/window/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ContextWiring } from './context.ts';
import { journalServed } from './served.ts';
import { journalUsage } from './usage.ts';
import { journalWindow } from './window.ts';

/**
 * Проводка экономики этапа 5 (план s5 §1): поток каждой сессии ядра проходит через этот кран —
 * расход хода (`turn.usage`), факты окна, дальше продолжение, контекст и маршруты. Зоны L и W
 * наполняют свои модули рядом (`usage.ts`, `window.ts`, `continuation.ts`, `context.ts`,
 * `routes.ts`) и подключают их здесь; рантайм сессий знает только этот интерфейс.
 */
export interface EconomyTap {
  /** Событие потока сессии — после ворота права, до подписчика шага. Не бросает. */
  onEvent(task: LiveTask, binding: SessionBinding, event: AdapterEvent): void;
}

export interface EconomyWiringOptions {
  note?: (event: string, data: Record<string, unknown>) => void;
  /** Часы стены (мс) для фактов окна; нет — `Date.now`. */
  now?: () => number;
  /** Книга окон ядра (G7): одна на процесс, её же читают судьи и health. Нет — своя. */
  windows?: WindowBook;
  /** Проводка контекста (C): первый `usage` сессии сверяется с ожиданием базы + брифа (дрейф). */
  context?: Pick<ContextWiring, 'onEvent'>;
}

export function createEconomyWiring(options: EconomyWiringOptions = {}): EconomyTap {
  const now = options.now ?? Date.now;
  const book = options.windows ?? new WindowBook();
  return {
    onEvent(task, binding, event) {
      if (event.type === 'usage') {
        journalUsage(task, binding, event);
        journalServed(task, binding, event);
      } else if (event.type === 'window') journalWindow(task, binding, event, book, now());
      options.context?.onEvent(task, binding, event);
    },
  };
}
