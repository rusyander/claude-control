import type { RawEvent } from './chat-events.ts';

/**
 * Заглушка CLI в ЖИВОМ потоке (аудит 25.09, L280): «ответ», которого модель не
 * давала, — `model: <synthetic>`, например «No response requested.» при
 * `--resume` до первого слова модели. История и конец хода его уже отсеивают
 * (`isSyntheticReply` в `ChatRecords.ts`), а поток — нет: запись приходила
 * шагом расхода с моделью `<synthetic>` и нулями, окно контекста в шапке
 * падало в ноль, а текст заглушки, если CLI отдавал его дельтами, ложился в
 * ленту и в хвост ответа, по которому конвейер решает судьбу группы.
 *
 * Правило то же, что в истории: модель `<synthetic>` или текст заглушки. Для
 * потоковых событий заглушка узнаётся по `message_start` и глушится до
 * `message_stop` — у дельт своей модели нет.
 */
const SYNTHETIC_MODEL = '<synthetic>';
const SYNTHETIC_TEXT = 'No response requested.';

type Message = NonNullable<RawEvent['message']>;

function textOf(message: Message | undefined): string {
  return (message?.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
    .trim();
}

export function isSyntheticMessage(message: Message | undefined): boolean {
  if (!message) return false;
  return message.model === SYNTHETIC_MODEL || textOf(message) === SYNTHETIC_TEXT;
}

/** Пропускать ли строку потока дальше; хранит, идёт ли сейчас потоковая заглушка. */
export class SyntheticGate {
  private muted = false;

  pass(raw: RawEvent): boolean {
    if (raw.type === 'assistant') return !isSyntheticMessage(raw.message);
    if (raw.type !== 'stream_event' || !raw.event) return true;
    const event = raw.event;
    if (event.type === 'message_start') {
      this.muted = event.message?.model === SYNTHETIC_MODEL;
      return !this.muted;
    }
    if (!this.muted) return true;
    if (event.type === 'message_stop') this.muted = false;
    return false;
  }
}
