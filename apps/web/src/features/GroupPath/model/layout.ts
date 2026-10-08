import type { GroupFlow } from '@agentdeck/contracts';
import type { LayoutItem } from './layout.types';
import type { PathRow } from './pathRows.types';

function blockSkill(row: PathRow): string | undefined {
  if (row.kind !== 'entry') return undefined;
  const { entry } = row;
  if (entry.kind === 'skill-step') return entry.skillId;
  if (entry.kind === 'custom') return entry.step.within?.skillId;
  return undefined;
}

export function buildLayout(rows: PathRow[], flow: GroupFlow | undefined): LayoutItem[] {
  const items: LayoutItem[] = [];
  let number = 0;
  rows.forEach((row, index) => {
    if (row.kind === 'entry' && row.entry.kind === 'builtin') {
      items.push({ kind: 'stage', stage: row.entry.stage, row, index });
      return;
    }
    number += 1;
    const numbered = { row, number, index };
    const skillId = flow === 'scenario' ? undefined : blockSkill(row);
    const last = items.at(-1);
    if (skillId && last?.kind === 'block' && last.skillId === skillId) last.items.push(numbered);
    else if (skillId) items.push({ kind: 'block', skillId, items: [numbered] });
    else items.push({ kind: 'row', item: numbered });
  });
  return items;
}
