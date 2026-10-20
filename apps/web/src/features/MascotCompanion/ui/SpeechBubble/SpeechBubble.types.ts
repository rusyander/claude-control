import type { CSSProperties } from 'react';
import type { ChatTarget } from '../../model/chatTargets.types';
import type { Speech } from '../../lib/useMascotCompanion.types';

export interface SpeechBubbleProps {
  speech: Speech;
  style: CSSProperties;
  onOpen: (target: ChatTarget) => void;
  onDismiss: () => void;
}
