import type { CSSProperties, Ref } from 'react';
import type { useMascotCompanion } from '../../lib/useMascotCompanion';
import type { ChatTarget } from '../../model/chatTargets.types';

export interface MascotPanelProps {
  ref?: Ref<HTMLDivElement>;
  style: CSSProperties;
  companion: ReturnType<typeof useMascotCompanion>;
  /** Escape: закрыть и вернуть фокус на Деку. */
  onClose: () => void;
  /** Переход в разговор: сводка закрывается, фокус уходит со страницей. */
  onNavigate: () => void;
}

export interface TargetListProps {
  kind: 'waiting' | 'errors' | 'running';
  tone: 'waiting' | 'error' | 'working';
  title: string;
  targets: ChatTarget[];
  onOpen: (target: ChatTarget) => void;
}
