import type { AgentRun } from './agent-runs.types';

export const listeners = new Set<() => void>();

/**
 * Живое состояние стора: сами прогоны, их потоки и подписчики. Лежит в модуле, а
 * не в React-состоянии, потому что прогон переживает и смену таба, и размонтаж
 * страницы; компоненты подключаются к нему через `useSyncExternalStore`.
 */

export const runs = new Map<string, AgentRun>();
