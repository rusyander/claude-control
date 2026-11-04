import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import {
  createReviewLinkWiring,
  type ReviewLinkWiring,
  type ReviewLinkWiringOptions,
} from '../review-link-wiring/index.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона F8 этапа 10 — ревью MR по ссылке: бриф (база диффа, нити MR, замечания для правки) и
 * публикация итога заметкой в MR раньше публикатора. Сама проводка — `bootstrap/review-link-wiring`;
 * одна на одни `deps` (`reviewLinkWiringFor`): ручка `POST /v1/review-link` и крючки — общий объект.
 */
const wirings = new WeakMap<ConductorWiringDeps, ReviewLinkWiring>();

export function reviewLinkWiringFor(
  deps: ConductorWiringDeps,
  options: ReviewLinkWiringOptions = {},
): ReviewLinkWiring {
  const known = wirings.get(deps);
  if (known) return known;
  const made = createReviewLinkWiring(
    {
      registry: deps.registry,
      coreHome: deps.layout.root,
      ...(deps.panelAppData === undefined ? {} : { panelAppData: deps.panelAppData }),
    },
    options,
  );
  wirings.set(deps, made);
  return made;
}

export function reviewLinkHooks(deps: ConductorWiringDeps): ConductorHooks {
  return reviewLinkWiringFor(deps).hooks;
}
