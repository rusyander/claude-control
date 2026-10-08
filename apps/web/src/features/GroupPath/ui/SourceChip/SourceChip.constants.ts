import type { StepSourceKind } from '../../model/stepSource.types';
import type { BadgeTone } from '@shared/ui/badge';

export const TONES: Record<StepSourceKind, BadgeTone> = {
  builtin: 'neutral',
  'our-skill': 'info',
  'project-skill': 'info',
  'plugin-skill': 'info',
  'foreign-skill': 'warning',
  skill: 'info',
  prompt: 'success',
  hook: 'accent',
  rule: 'accent',
  script: 'accent',
};
