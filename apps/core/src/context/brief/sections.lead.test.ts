import { describe, expect, it } from 'vitest';
import type { ReconMap } from '@agentdeck/contracts/core/lead';
import { buildBrief } from './brief.ts';
import {
  PREVIOUS_ATTEMPT_BYTES,
  previousAttemptPart,
  RECON_BRIEF_BYTES,
  RECON_FILES_LISTED,
  reconMapPart,
} from './sections.ts';

/**
 * Секции ведущего (W2-7, W2-10): карта разведки в брифе плана — строки целиком, файлы путём и
 * причиной, тел файлов нет; лишнее выпадает целыми строками с пометкой. Прошлая попытка — id
 * записи провала и причина, не больше 600 байт.
 */

const STEP = '0192f000-0000-7000-8000-0000000000cc';
const BODY = 'export function secretBody() { return 42; }';

const map = (over: Partial<ReconMap> = {}): ReconMap => ({
  lines: ['login lives in apps/web/src/features/Login', 'the API is POST /api/login'],
  files: [{ path: 'apps/web/src/features/Login/Login.tsx', why: 'the form' }],
  tests: ['apps/web/src/features/Login/Login.test.tsx'],
  owners: ['web'],
  ...over,
});

describe('recon-map brief section', () => {
  it('golden: the map lines, files with why, tests and owners — no file body', () => {
    const part = reconMapPart(map(), STEP)!;
    expect(part.text).toBe(
      [
        `Recon map (step ${STEP}):`,
        '- login lives in apps/web/src/features/Login',
        '- the API is POST /api/login',
        'Files (1):',
        '- apps/web/src/features/Login/Login.tsx: the form',
        'Tests (1): apps/web/src/features/Login/Login.test.tsx',
        'Owners: web',
      ].join('\n'),
    );
    expect(part.text).not.toContain(BODY);
    expect(buildBrief([part], 'plan').text).toContain('## recon-map\n');
  });

  it(`lists at most ${RECON_FILES_LISTED} files and counts the rest`, () => {
    const files = Array.from({ length: 14 }, (_, i) => ({ path: `src/f${i}.ts`, why: 'w' }));
    const text = reconMapPart(map({ files }), STEP)!.text;
    expect(text).toContain('- src/f9.ts: w');
    expect(text).not.toContain('src/f10.ts');
    expect(text).toContain('+4 more files in the recon step record.');
  });

  it('drops whole lines past the budget and says how many', () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(250)}`,
    );
    const part = reconMapPart(map({ lines }), STEP)!;
    const shown = part.text.split('\n');
    for (const l of shown.slice(1, -1)) expect(lines.map((x) => `- ${x}`)).toContain(l);
    expect(shown.at(-1)).toMatch(/^\(\d+ more map lines omitted: read the recon step record\.\)$/);
    expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(RECON_BRIEF_BYTES + 80);
    // Секция укладывается в свою корзину: сборка брифа плана не отказывает.
    expect(() => buildBrief([part], 'plan')).not.toThrow();
  });
});

describe('previous-attempt brief section', () => {
  it('names the step, the failure record and the tier', () => {
    const part = previousAttemptPart({
      stepId: STEP,
      recordId: 'rec-1',
      why: 'a check went red',
      tier: 'opus high',
    });
    expect(part?.text).toBe(
      `Previous attempt of step ${STEP} failed (record rec-1); now running at tier opus high.\nWhy: a check went red`,
    );
  });

  it(`stays within ${PREVIOUS_ATTEMPT_BYTES} bytes`, () => {
    const part = previousAttemptPart({
      stepId: STEP,
      recordId: null,
      why: 'я'.repeat(2000),
      tier: null,
    })!;
    expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(PREVIOUS_ATTEMPT_BYTES);
    expect(part.text.endsWith('…')).toBe(true);
  });

  it('cuts the reason on code points: no lone surrogate half at the cut', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Сдвиг 0–3 байта — какая-то из границ среза обязательно падает посреди пары.
    for (let shift = 0; shift < 4; shift++) {
      const part = previousAttemptPart({
        stepId: STEP,
        recordId: null,
        why: `${'a'.repeat(shift)}${'😀'.repeat(400)}`,
        tier: null,
      })!;
      expect(lone.test(part.text)).toBe(false);
      expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(PREVIOUS_ATTEMPT_BYTES);
    }
  });

  it('nothing to say → no section', () => {
    expect(previousAttemptPart({ stepId: STEP, recordId: null, why: ' ', tier: null })).toBeNull();
  });
});
