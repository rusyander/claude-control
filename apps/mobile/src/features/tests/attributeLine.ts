import type { ProjectTestCase } from '@agentdeck/contracts';
import { useT } from '../../shared/config/i18n';

/** Тип, важность, зона и метки одной строкой — то, по чему идёт отбор. */
export function attributeLine(testCase: ProjectTestCase, t: ReturnType<typeof useT>): string {
  const parts = [t.tests.kind[testCase.type ?? 'case']];
  // Карантин — первым после типа: он объясняет красный статус строки, и
  // прочитать его нужно раньше, чем метки.
  if (testCase.muted) parts.push(t.tests.muted);
  if (testCase.priority) parts.push(t.tests.priority[testCase.priority]);
  if (testCase.automation?.status) parts.push(t.tests.automation[testCase.automation.status]);
  if (testCase.section) parts.push(testCase.section);
  else if (testCase.area) parts.push(testCase.area);
  for (const tag of testCase.tags ?? []) parts.push(`#${tag}`);
  return parts.join(' · ');
}
