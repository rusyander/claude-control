import type { TestFilterState } from './TestFilters/TestFilters.types';

export function isFilterEmpty(filter: TestFilterState): boolean {
  return !filter.status && !filter.priority && !filter.tag;
}
