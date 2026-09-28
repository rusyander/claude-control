import type { GroupListItem } from '@entities/Group';

export interface GroupPairSwitchProps {
  /** Глобальная копия. */
  group: GroupListItem;
  /** Проектный оригинал. */
  pair: GroupListItem;
  /** Проект, в котором выбирается сторона. */
  path: string;
  /** Действует ли в проекте глобальная сторона; `undefined` — ещё не известно. */
  isGlobalActive: boolean | undefined;
  isError: boolean;
}
