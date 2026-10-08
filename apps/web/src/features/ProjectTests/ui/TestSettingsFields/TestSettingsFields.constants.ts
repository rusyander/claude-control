import type { ProjectTestAttributeDef } from '@agentdeck/contracts';

export const TYPES: ProjectTestAttributeDef['type'][] = ['text', 'select', 'number'];

export const EMPTY: ProjectTestAttributeDef = { key: '', title: '', type: 'text' };
