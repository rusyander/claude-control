import type { RowType } from '../../model/rowWords.types';
import type { BadgeTone } from '@shared/ui/badge';

export const TONES: Record<RowType, BadgeTone> = {
  stage: 'neutral',
  'our-skill': 'info',
  'foreign-skill': 'warning',
  prompt: 'success',
  hook: 'accent',
  rule: 'accent',
  script: 'neutral',
};
