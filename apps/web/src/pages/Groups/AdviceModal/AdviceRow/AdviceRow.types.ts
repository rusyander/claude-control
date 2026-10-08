import type { MemberAdvice } from '@agentdeck/contracts';

export interface AdviceRowProps {
  item: MemberAdvice;
  isPicked: boolean;
  onToggle: () => void;
}
