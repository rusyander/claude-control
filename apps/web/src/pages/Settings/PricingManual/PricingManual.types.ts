import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';

export interface PricingManualProps {
  /** Свои цены из настроек — ручные среди них отбираются здесь. */
  custom: Record<string, ModelPricing>;
  /** Строки прайса: своя цена строки прайса ручной не считается. */
  entries: readonly PricingEntry[];
  /** Сохранить свои цены целиком. */
  onSave: (next: Record<string, ModelPricing>) => void;
  isSaving: boolean;
}
