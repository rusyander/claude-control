import { PRICING_FIELDS } from './PricingRow.constants';

export type PricingField = (typeof PRICING_FIELDS)[number];

/** Набранное в форме — строками: пока печатают, число может быть неполным. */
export type PricingDraft = Partial<Record<PricingField, string>>;
