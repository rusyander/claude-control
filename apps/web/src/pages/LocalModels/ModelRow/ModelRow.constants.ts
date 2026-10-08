import type { CatalogRow } from '@entities/LocalModels';
import type { BadgeTone } from '@shared/ui/badge';

export const FIT_TONE: Record<CatalogRow['fit']['level'], BadgeTone> = {
  gpu: 'success',
  partial: 'warning',
  cpu: 'warning',
  none: 'neutral',
};
