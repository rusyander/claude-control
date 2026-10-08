import type { ProjectTestCase } from '@agentdeck/contracts';

/** Значения, которые реально встречаются в наборе, — из них строится фильтр. */
export interface CaseFacets {
  sections: string[];
  areas: string[];
  tags: string[];
}

export function collectFacets(cases: ProjectTestCase[]): CaseFacets {
  const sections = new Set<string>();
  const areas = new Set<string>();
  const tags = new Set<string>();
  for (const item of cases) {
    if (item.section) sections.add(item.section);
    if (item.area) areas.add(item.area);
    for (const tag of item.tags ?? []) tags.add(tag);
  }
  const sorted = (set: Set<string>): string[] => [...set].sort((a, b) => a.localeCompare(b));
  return { sections: sorted(sections), areas: sorted(areas), tags: sorted(tags) };
}
