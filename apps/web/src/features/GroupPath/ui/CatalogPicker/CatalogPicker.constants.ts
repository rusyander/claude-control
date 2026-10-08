import type { CatalogItemType } from '@agentdeck/contracts';
import type { RowType } from '../../model/rowWords.types';

export const TYPES: readonly CatalogItemType[] = ['skill', 'rule', 'hook', 'script'];

export const ROW_TYPE: Record<CatalogItemType, RowType> = {
  skill: 'our-skill',
  rule: 'rule',
  hook: 'hook',
  script: 'script',
};
