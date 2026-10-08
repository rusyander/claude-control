import type { RowType } from './rowWords.types';
import type { StepSourceKind, StepSource } from './stepSource.types';

export const TYPE_OF_SOURCE: Record<StepSourceKind, RowType> = {
  builtin: 'stage',
  'our-skill': 'our-skill',
  'project-skill': 'our-skill',
  skill: 'our-skill',
  'plugin-skill': 'foreign-skill',
  'foreign-skill': 'foreign-skill',
  prompt: 'prompt',
  hook: 'hook',
  rule: 'rule',
  script: 'script',
};

export function rowType(source: StepSource): RowType {
  return TYPE_OF_SOURCE[source.kind];
}
