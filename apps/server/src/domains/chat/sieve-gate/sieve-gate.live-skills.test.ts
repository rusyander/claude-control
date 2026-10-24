import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_SIEVES, type SieveReportRow } from '@agentdeck/contracts/sieves';
import { sieveDeliveryGaps } from './sieve-gate.ts';

/**
 * F-39: тексты навыков доставки (`prepare-mr`, `ticket-delivery-2`) называют
 * живые сита — те, чьё «not checked: <причина>» снимает пробел заметкой. Список
 * в тексте разошёлся с воротами (в нём не было `migration-safety`), и группа
 * крутила доставку на пробеле, который сама не могла закрыть. Живое множество
 * берётся не копией `LIVE_SIEVES`, а поведением настоящих ворот: каждому ситу —
 * строка «not checked», и заметку получает ровно живое.
 */

const SKILLS = fileURLToPath(
  new URL('../../../../assets/kit/agentdeck-kit/skills/', import.meta.url),
);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Список ид в скобках после `lead`; описание после « — » внутри скобок отбрасывается. */
function listAfter(text: string, lead: RegExp): string[] {
  const match = new RegExp(`${lead.source}\\s*\\(([^)]+)\\)`).exec(text.replace(/\s+/g, ' '));
  if (!match?.[1]) throw new Error(`no live-sieve list after ${lead.source}`);
  const [ids = ''] = match[1].split(' — ');
  return ids
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .sort();
}

const skill = (path: string) => readFileSync(join(SKILLS, path), 'utf8');

/** Живые сита по поведению ворот доставки группы на настоящем git. */
async function liveByGate(): Promise<string[]> {
  const work = mkdtempSync(join(tmpdir(), 'sieve-live-skills-'));
  dirs.push(work);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'page.tsx'), 'export const Page = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'c']);
  const ids = [...new Set([...BUILTIN_SIEVES.map((sieve) => sieve.id), 'branch-backend-stand'])];
  const rows: SieveReportRow[] = ids.map((id) => ({
    id,
    status: 'fail',
    evidence: 'not checked: no stand, no browser, no network here',
    at: new Date().toISOString(),
  }));
  const gaps = await sieveDeliveryGaps({ cwd: work, rows });
  return [...(gaps.noted ?? [])].sort();
}

describe('живые сита в текстах навыков доставки = живые сита ворот (F-39)', () => {
  it('prepare-mr и ticket-delivery-2 называют ровно те сита, чьё «not checked» ворота снимают', async () => {
    const live = await liveByGate();
    // Проба не пустая: без неё «равно» прошло бы на двух пустых списках.
    expect(live.length).toBeGreaterThan(0);
    expect(listAfter(skill('prepare-mr/SKILL.md'), /Live (?:sieves|checks)/)).toEqual(live);
    expect(
      listAfter(skill('ticket-delivery-2/SKILL.md'), /A LIVE sieve that cannot run here/),
    ).toEqual(live);
  });
});
