import type { CreateGroupKind } from './CreateGroupChooser.types';

export const KINDS: { kind: CreateGroupKind; icon: 'play' | 'groups' }[] = [
  { kind: 'scenario', icon: 'play' },
  { kind: 'bundle', icon: 'groups' },
];
