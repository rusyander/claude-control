import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { humanAncestor, INSTRUCTION_MARKERS, liveBase } from './clean-base.ts';

/**
 * Стражу чистой базы живого стенда (F2): файл инструкций над базой — отказ, а не тихий прогон со
 * слоем человека. Предки строятся внутри базы прогона, настоящий профиль не трогается.
 */

const root = mkdtempSync(join(liveBase(), 'clean-base-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('live stand base: no human instruction file above it', () => {
  it('the base this run hands to live stands is clean (temp of a Windows profile is not)', () => {
    expect(humanAncestor(liveBase())).toBeUndefined();
  });

  it.each(INSTRUCTION_MARKERS)('%s two levels up refuses the base and names the file', (name) => {
    const top = mkdtempSync(join(root, 'dirty-'));
    const marker = join(top, name);
    if (name.endsWith('.md')) writeFileSync(marker, 'HUMAN');
    else mkdirSync(marker);
    const deep = join(top, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(humanAncestor(deep)).toBe(marker);
    expect(() => liveBase(deep)).toThrow(marker);
  });

  it('a clean directory that does not exist yet is created and returned', () => {
    const fresh = join(root, 'fresh', 'base');
    expect(liveBase(fresh)).toBe(fresh);
  });
});
