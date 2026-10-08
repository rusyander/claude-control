import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';

export interface ModelCardProps {
  platform: Platform;
  /** Итог последней пробы: из него берётся каталог моделей. */
  health: PlatformHealthRecord | undefined;
  /** Контур принимает усилие рассуждения (манифест драйвера). */
  effort: boolean;
}
