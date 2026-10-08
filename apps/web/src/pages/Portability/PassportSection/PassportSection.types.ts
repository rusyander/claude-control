import type { EnvItem, EnvSkip, EnvSectionState } from '@agentdeck/contracts/portable-env';

export interface PassportSectionProps {
  title: string;
  items: readonly EnvItem[];
  skipped: readonly EnvSkip[];
  /** Рубильник этого раздела у источника, если он выключен целиком (П2.6). */
  sectionState?: EnvSectionState | undefined;
  /** Развёрнут ли вид: свёрнутым показан только заголовок с числами. */
  open: boolean;
  onToggle: () => void;
  /** DOM-id тела вида — для `aria-controls` заголовка. */
  bodyId: string;
}
