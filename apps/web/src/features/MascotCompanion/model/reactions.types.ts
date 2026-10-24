/** События, на которые Дека отвечает реакцией (`mascot.react.<род>`). */
export type ReactionKind =
  | 'linkLost'
  | 'linkBack'
  | 'runFailed'
  | 'groupFailed'
  | 'groupStopped'
  | 'limitHit'
  | 'longDone'
  | 'groupDelivered';

/** Что Дека помнит о прошлых реакциях: когда говорил и какой формулировкой. */
export interface ReactionMemory {
  lastAt: number | undefined;
  byKind: Partial<Record<ReactionKind, number>>;
  variant: Partial<Record<ReactionKind, number>>;
}

export interface ReactionPick {
  kind: ReactionKind;
  variant: number;
  memory: ReactionMemory;
}
