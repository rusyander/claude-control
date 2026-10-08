import type { PathAnchor, PathResourceType } from '@agentdeck/contracts';

/**
 * Откуда брать описание строки. Сводка ресурса стоит серверу вызова модели при
 * промахе кэша — поэтому это не текст, а указание: спросит только показанная
 * подсказка или открытое окно шага.
 */
export type RowText =
  | { kind: 'stage'; stage: PathAnchor }
  | { kind: 'text'; text: string }
  | { kind: 'summary'; type: PathResourceType; id: string; project?: string };
