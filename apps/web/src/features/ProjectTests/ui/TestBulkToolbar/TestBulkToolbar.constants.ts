import type { BulkAction } from './TestBulkToolbar.types';

export const VALUE_FROM: Record<
  BulkAction,
  'none' | 'text' | 'reason' | 'priority' | 'readiness' | 'automation' | 'section' | 'group'
> = {
  tag: 'text',
  untag: 'text',
  priority: 'priority',
  readiness: 'readiness',
  automation: 'automation',
  section: 'section',
  move: 'group',
  duplicate: 'none',
  archive: 'none',
  restore: 'none',
  // Причина карантина обязательна — её требует и сервер: карантин без
  // объяснения через месяц никто не решится снять, потому что неизвестно, чего
  // он ждал.
  mute: 'reason',
  unmute: 'none',
  delete: 'none',
};

export const ACTIONS: readonly BulkAction[] = [
  'tag',
  'untag',
  'priority',
  'readiness',
  'automation',
  'section',
  'move',
  'duplicate',
  'archive',
  'restore',
  'mute',
  'unmute',
  'delete',
];

export const PRIORITIES: readonly string[] = ['blocker', 'high', 'medium', 'low'];

export const READINESS: readonly string[] = ['draft', 'ready', 'obsolete'];

export const AUTOMATION: readonly string[] = ['manual', 'toAutomate', 'automated'];
