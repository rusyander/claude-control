export { useProviders, useProviderDetect } from './api/ProviderApi';
export {
  detectionBadge,
  findDetection,
  installedProviders,
  recommendedProviderId,
  activeCliHint,
  type DetectionBadge,
  type DetectionBadgeKind,
  type TextKey,
} from './model/detection';
export {
  activeProvider,
  activeCapabilities,
  isCapabilityReady,
  navItemAccess,
  gateNavSections,
  visibleNavItems,
  summarizeNavCapabilities,
  type SectionAccess,
  type ProviderCapabilities,
  type GatedNavItem,
  type GatedNavSection,
  type CapabilitySummary,
} from './model/gating';
export { useIsCapabilityReady } from './model/useCapability';
