import type { PathStep } from '@agentdeck/contracts';
import type { PathSlot } from './pathEdit.types';

export function placed(step: PathStep, slot: PathSlot): PathStep {
  const { within: _drop, ...rest } = step;
  return slot.within
    ? { ...rest, anchor: slot.anchor, within: slot.within }
    : { ...rest, anchor: slot.anchor };
}
