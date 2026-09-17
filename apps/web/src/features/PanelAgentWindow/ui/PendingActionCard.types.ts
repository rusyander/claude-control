import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

export interface PendingActionCardProps {
  pending: PanelPendingAction;
  /** Клик отправлен, итог ещё не пришёл кадром. */
  isDeciding: boolean;
  /** Сервер не принял решение (404/409/403) — причина словами. */
  error?: string;
  /**
   * Сервер ответил на одобрение 409 `preview_truncated`: предпросмотр неполный,
   * хотя карточка об этом не знала. «Выполнить» гаснет, карточка остаётся.
   */
  approveRefused?: boolean;
  onDecide: (decision: 'approve' | 'reject') => void;
  /** Первая карточка в окне забирает фокус на кнопку по умолчанию. */
  autoFocus: boolean;
}
