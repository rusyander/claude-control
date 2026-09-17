import type { RefObject } from 'react';
import type { ConversationViewProps } from './ConversationView.types';

export type PanelAgentView = 'conversation' | 'history' | 'journal';

export interface PanelAgentWindowProps extends ConversationViewProps {
  isOpen: boolean;
  /** Крестик или Escape внутри окна; фокус возвращает вызывающий. */
  onClose: () => void;
  /** Растёт на каждую просьбу кнопки агента перевести фокус в окно. */
  focusRequest: number;
  /** Разметка окна — кнопке агента, чтобы вернуть в него фокус со страницы. */
  panelRef: RefObject<HTMLElement | null>;
}
