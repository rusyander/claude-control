/**
 * Описание MR из журнала (05 §Push and MR): итог, что меняет каждое требование и какие проверки
 * это показывают (имена и результаты, не id), связанные MR той же задачи, как проверить. Текст
 * потом идёт через `publisher/text`: здесь нет ни id записей, ни путей машины, ни слов процесса —
 * инструкции нумерованным списком (`1. …`), никогда «Step 1» (сито отказывает `step <n>`).
 */

export interface MrDescriptionInput {
  title: string;
  summary: string;
  requirements: {
    text: string;
    verdict: string;
    checks: { name: string; result: string }[];
  }[];
  /** MR других единиц задачи (P76): каждый MR называет остальные. */
  linked: { name: string; url: string }[];
  testing: string[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function buildMrDescription(input: MrDescriptionInput): { title: string; body: string } {
  const out: string[] = [];
  const summary = input.summary.trim();
  if (summary) out.push(summary, '');
  if (input.requirements.length > 0) {
    out.push('## Changes');
    for (const r of input.requirements) {
      out.push(`- ${oneLine(r.text)} (${r.verdict})`);
      for (const c of r.checks) out.push(`  - ${oneLine(c.name)}: ${oneLine(c.result)}`);
    }
    out.push('');
  }
  if (input.linked.length > 0) {
    out.push('## Related merge requests');
    for (const l of [...input.linked].sort((a, b) => a.url.localeCompare(b.url))) {
      out.push(`- ${oneLine(l.name)}: ${l.url}`);
    }
    out.push('');
  }
  if (input.testing.length > 0) {
    out.push('## How to test');
    input.testing.forEach((t, i) => out.push(`${i + 1}. ${oneLine(t)}`));
    out.push('');
  }
  return { title: oneLine(input.title), body: out.join('\n').trimEnd() };
}
