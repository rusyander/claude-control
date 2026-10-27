import type { TelegramLastSend } from '@agentdeck/contracts';
import type { TelegramCardDraft } from '../../model/telegramCard.types';

export interface TelegramAdvancedProps {
  draft: TelegramCardDraft;
  onChange: (patch: Partial<TelegramCardDraft>) => void;
  /** Новый токен бота уведомлений (уходит с «Сохранить»). */
  token: string;
  onToken: (token: string) => void;
  maskedToken?: string;
  onForget: () => void;
  /** Поле отдельного бота ответов — только при same-bot или сохранённом токене. */
  answersToken?: { value: string; onChange: (token: string) => void; masked?: string };
  onCheck: () => void;
  checking: boolean;
  /** Итог живой проверки словами сервера. */
  checkDetail?: string;
  onRestart: () => void;
  restarting: boolean;
  lastSend?: TelegramLastSend;
  /** Состояние опроса ответов строкой («Ответы: слушаю бота — …»). */
  answersState?: string;
}
