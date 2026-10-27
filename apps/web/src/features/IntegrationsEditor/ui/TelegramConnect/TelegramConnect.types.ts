import type { TelegramConnectView } from '@agentdeck/contracts/telegram-answers';

export interface TelegramConnectBlockProps {
  view: TelegramConnectView;
  /** Токен бота сохранён в карточке — без него окно не открыть. */
  hasToken: boolean;
  busy: boolean;
  onOpen: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}
