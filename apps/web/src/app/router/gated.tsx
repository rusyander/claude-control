import type { Capability } from '@claude-control/contracts';
import type { RouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { RouteGate } from './RouteGate';

/**
 * Обернуть страницу гейтом возможности провайдера: у активного провайдера раздел
 * либо работает (страница), либо «в разработке»/недоступен (заглушка). Для
 * Claude гейт прозрачен — страница показывается как прежде.
 */
export function gated(capability: Capability, Page: RouteComponent): RouteComponent {
  function GatedRoute(): ReactElement {
    return (
      <RouteGate capability={capability}>
        <Page />
      </RouteGate>
    );
  }
  // Обёртка не должна прятать preload: без него роутер узнал бы о ленивом
  // чанке только при рендере — с пустым экраном на время загрузки.
  GatedRoute.preload = Page.preload;
  return GatedRoute;
}
