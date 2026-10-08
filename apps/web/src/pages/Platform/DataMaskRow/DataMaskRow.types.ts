import type { Platform, PlatformDataMask } from '@agentdeck/contracts';

export interface Props {
  platform: Platform;
  /**
   * Решение СЕРВЕРА — тем же кодом, каким шлюз маскирует запрос. Необязательно:
   * ответ старого сервера его не приносит, и тогда строки нет вовсе — показать
   * тумблер без решения значило бы обещать маску, которой в запросе может не быть.
   */
  mask?: PlatformDataMask;
  onChange: (next: Platform) => void;
}
