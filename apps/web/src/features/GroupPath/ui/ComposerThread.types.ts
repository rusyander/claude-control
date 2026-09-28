import type { ComposerTurn } from '../model/useStepComposer';

export interface ComposerThreadProps {
  turns: ComposerTurn[];
  isThinking: boolean;
}
