import type { NavItem } from '@shared/config/navigation';
import type { ProviderCapabilities } from './gating.types';
import { navItemAccess } from './navItemAccess';

/** Плоский список навигационных разделов, доступных к переходу (не скрытых). */
export function visibleNavItems(items: NavItem[], capabilities: ProviderCapabilities): NavItem[] {
  return items.filter((item) => navItemAccess(item, capabilities) !== 'hidden');
}
