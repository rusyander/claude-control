import type { Platform } from '@agentdeck/contracts';
import { foreignProviderId, platformRunConsumers } from '@agentdeck/contracts/platform-consumers';

/**
 * Карточка модели контура: что показать и что человек вправе выбрать (Т6).
 * Чистые функции — решение считается здесь, а рисуется в `ModelCard.tsx`.
 */

/** Строка «модель на потребителя»: кому, что стоит сейчас. */
export interface ConsumerModelRow {
  consumer: string;
  /** Имя провайдера у чужого CLI: «codex». Пусто — потребитель встроенный. */
  foreign: string;
  /** Переопределение этого потребителя; пусто — идёт модель контура. */
  model: string;
}

/**
 * Потребители, которым модель вообще имеет смысл переопределять: те, что ходят
 * ПРОЦЕССОМ и отмечены у контура.
 *
 * Ассистента и терминала здесь нет намеренно. Ассистент ходит управляемым
 * профилем, терминал — записанным файлом, и у обоих модель ровно одна — та, что
 * лежит в профиле. Строка «модель для терминала» обещала бы выбор, которого в
 * файле некуда положить.
 */
export function consumerModelRows(platform: Platform): ConsumerModelRow[] {
  return platform.consumers
    .filter(
      (consumer) =>
        (platformRunConsumers as readonly string[]).includes(consumer) ||
        foreignProviderId(consumer) !== undefined,
    )
    .map((consumer) => ({
      consumer,
      foreign: foreignProviderId(consumer) ?? '',
      model: platform.consumerModels[consumer] ?? '',
    }));
}
