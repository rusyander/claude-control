import type { ReactNode } from 'react';
import type { CardHealth } from '../../model/telegramCard';
import type { TelegramCardDraft } from '../../model/telegramCard.types';

/** Шаг 1 до подключения: токен и проверка. */
export interface TelegramSetupProps {
  token: string;
  onToken: (token: string) => void;
  maskedToken?: string;
  onCheck: () => void;
  checking: boolean;
  /** Итог проверки: имя бота или отказ словами сервера. */
  checkLine?: { ok: boolean; text: string };
}

export interface TelegramCardViewProps {
  connected: boolean;
  enabled: boolean;
  health: CardHealth;
  /** «Анна (@anna)» из подтверждения /start или «id 777». */
  ownerLabel: string;
  draft: TelegramCardDraft;
  onChange: (patch: Partial<TelegramCardDraft>) => void;
  onMaster: (enabled: boolean) => void;
  masterBusy: boolean;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  /** Строка итога сохранения: «Сохранено» или что именно не записалось. */
  saveLine?: { ok: boolean; text: string };
  onTest: () => void;
  testing: boolean;
  setup: TelegramSetupProps;
  /** Подключение по /start (шаг 2 и «Переподключить»). */
  connect: ReactNode;
  reconnecting: boolean;
  onReconnect: () => void;
  advanced: ReactNode;
  /** «?» — справка «Интеграции»: длинные объяснения живут там, а не на карточке. */
  helpLink: ReactNode;
}
