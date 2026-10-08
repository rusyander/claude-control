import type { ProjectTestCase } from '@agentdeck/contracts';

/** Метки, которые вообще встречаются в этой группе. */
export function tagsOf(cases: ProjectTestCase[]): string[] {
  const found = new Set<string>();
  for (const item of cases) for (const tag of item.tags ?? []) found.add(tag);
  return [...found].sort();
}
