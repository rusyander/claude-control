import type { Capability } from '@claude-control/contracts';
import type { ComponentType, ReactElement } from 'react';
import { RouteGate } from './RouteGate';

/**
 * Обернуть страницу гейтом возможности провайдера: у активного провайдера раздел
 * либо работает (страница), либо «в разработке»/недоступен (заглушка). Для
 * Claude гейт прозрачен — страница показывается как прежде.
 */
export function gated(capability: Capability, Page: ComponentType) {
  return function GatedRoute(): ReactElement {
    return (
      <RouteGate capability={capability}>
        <Page />
      </RouteGate>
    );
  };
}
