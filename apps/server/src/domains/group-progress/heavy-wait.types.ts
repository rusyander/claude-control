import type { ChatProgress } from '@agentdeck/contracts';

/** Ожидание места в очереди тяжёлых шагов — поле прогресса разговора. */
export type HeavyQueueWait = NonNullable<ChatProgress['heavyQueue']>;
