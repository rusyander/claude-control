import type { TelegramCardDraft } from '../../model/telegramCard.types';

export interface TelegramWhenProps {
  draft: TelegramCardDraft;
  onChange: (patch: Partial<TelegramCardDraft>) => void;
}
