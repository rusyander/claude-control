import type { CSSProperties } from 'react';
import type { ChatTarget } from '../../model/chatTargets.types';
import type { Speech } from '../../lib/useMascotCompanion.types';

export interface SpeechBubbleProps {
  speech: Speech;
  /** Место облачка у боковой панели; у реплики в потоке страницы не нужно. */
  style?: CSSProperties;
  /**
   * Реплика в потоке страницы (чат — над полем ввода), а не облачко поверх:
   * с лицом Деки слева, без хвостика и без своей живой области — её несёт место.
   */
  inline?: boolean;
  onOpen: (target: ChatTarget) => void;
  onDismiss: () => void;
}
