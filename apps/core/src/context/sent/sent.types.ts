import type { SentSection } from '../brief/brief.types.ts';

/** Отданное сессии: id секции → sha256 показанного текста (свёртка `sent[sessionId]`). */
export type SentSet = Readonly<Record<string, string>>;

/** Форма строки `brief.sent`. */
export type SentForm = 'brief' | 'delta' | 'review-pack';

/** Сообщение возобновления: только изменённые секции, с меткой платформы. */
export interface Delta {
  text: string;
  sections: SentSection[];
  /** Секции, что уже у модели и не уходят (названы для ленты, не для модели). */
  kept: string[];
  masked: number;
}
