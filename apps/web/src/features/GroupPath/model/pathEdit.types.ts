import type { PathAnchor, PathWithin } from '@agentdeck/contracts';

/** Место своего шага: стадия, после которой он идёт, и — внутри порядка скилла — где именно. */
export interface PathSlot {
  anchor: PathAnchor;
  within?: PathWithin;
}
