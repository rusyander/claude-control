import type { BriefPart } from '../brief/brief.types.ts';
import { findingsPart, handoffPart, platformRulesPart } from '../brief/sections.ts';

/**
 * Части брифа по виду шага (P13): набор секций каждого вида из портов ядра + части зон. Один
 * набор у снимка брифа и у живого замера на заглушке — снимок и тело запроса судят одно и то же.
 */

export const P13_KINDS = ['plan', 'work', 'review', 'fix'] as const;

const part = (id: BriefPart['id'], text: string, from: string): BriefPart => ({ id, text, from });

export function kindParts(kind: string): BriefPart[] {
  const parts: BriefPart[] = [
    part('task', 'Add a greeting file', 'conductor/scenario'),
    part(
      'step',
      `Write the change (${kind}, step s1 of default@1, round 1)\nDone when:\n- step_done`,
      'conductor/scenario',
    ),
    part(
      'requirements',
      '- R1 id 0192f0e0-0000-7000-8000-000000000001: hello.txt says hello',
      'conductor/requirements',
    ),
    part('knowledge', 'skill greeting\nrule lf-endings', 'conductor/scenario'),
  ];
  const rules = platformRulesPart(kind, '.agentdeck/notebook.agent.md');
  if (rules) parts.push(rules);
  const handoff = handoffPart({
    doneSteps: [{ title: 'Plan', kind: 'plan', outcome: 'done' }],
    changedFiles: kind === 'plan' ? [] : ['hello.txt'],
    notebook: { path: '.agentdeck/notebook.agent.md', text: '# Task notebook\n- stand: none' },
  });
  if (handoff) parts.push(handoff);
  if (kind === 'fix' || kind === 'review') {
    const findings = findingsPart(
      [{ id: 'R-1', title: 'greeting lacks newline' }],
      '.agentdeck/review-findings.agent.md',
    );
    if (findings) parts.push(findings);
  }
  return parts;
}
