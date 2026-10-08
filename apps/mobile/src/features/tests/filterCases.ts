import type { ProjectTestCase } from '@agentdeck/contracts';
import type { TestFilterState } from './TestFilters/TestFilters.types';

export function filterCases(cases: ProjectTestCase[], filter: TestFilterState): ProjectTestCase[] {
  return cases.filter((item) => {
    if (filter.status && item.status !== filter.status) return false;
    if (filter.priority && item.priority !== filter.priority) return false;
    if (filter.tag && !(item.tags ?? []).includes(filter.tag)) return false;
    return true;
  });
}
