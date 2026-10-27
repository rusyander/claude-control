import { describe, expect, it } from 'vitest';
import {
  fixStagePrompt,
  groupScopeOf,
  PROVEN_MAX,
  provenLines,
  verifyStagePrompt,
} from '@agentdeck/contracts/model-cascade';

/**
 * Аудит g8 26.10 (N2/N9): раздел `Proven:` итога правок и границы группы — по
 * ним задание проверки и правок говорит «не повторять» и «baseline только на
 * чужом». Разбор — то, что звено реально пишет: жирный заголовок, нумерация,
 * русский заголовок, несколько разделов.
 */
describe('provenLines: раздел доказанного из итога правок', () => {
  it('жирный заголовок и нумерация; раздел кончается первой строкой не-пунктом', () => {
    const text = [
      'Сделал.',
      '**Proven:**',
      '1. F-1 mutant a.ts:3 killed by «a > b»',
      '2) F-2 ledger key 82bee40a',
      'Итого всё.',
      '- не из раздела',
    ].join('\n');
    expect(provenLines(text)).toEqual([
      'F-1 mutant a.ts:3 killed by «a > b»',
      'F-2 ledger key 82bee40a',
    ]);
  });

  it('берётся последний раздел; русский заголовок тоже; пустая строка до пунктов допустима', () => {
    const text = [
      'Proven:',
      '- старое',
      '',
      '## Доказано',
      '',
      '- новое',
      '* ещё',
      '',
      '- после',
    ].join('\n');
    expect(provenLines(text)).toEqual(['новое', 'ещё']);
  });

  it('нет раздела или «Proven» внутри фразы — пусто; потолок строк держится', () => {
    expect(provenLines('Proven: всё, что смог.\n- F-1')).toEqual([]);
    expect(provenLines('Исправил.')).toEqual([]);
    const many = ['Proven:', ...Array.from({ length: 50 }, (_, i) => `- p${i}`)].join('\n');
    expect(provenLines(many)).toHaveLength(PROVEN_MAX);
  });
});

describe('groupScopeOf и абзац границ', () => {
  it('план без единого owns — границ нет; owns пустой у группы — чужое всё', () => {
    expect(groupScopeOf([{}, {}], 0)).toBeUndefined();
    expect(groupScopeOf([{ owns: [] }, { owns: ['b.ts'] }], 0)).toEqual({
      own: [],
      others: ['b.ts'],
    });
    expect(groupScopeOf([{ owns: ['a.ts'] }], 3)).toBeUndefined();
  });

  it('чужих путей больше потолка — список обрезан строкой «… and N more»', () => {
    const others = Array.from({ length: 45 }, (_, i) => `p${i}.mdx`);
    const prompt = fixStagePrompt(['🟡 x'], { scope: { own: [], others } });
    expect(prompt).toContain('- p39.mdx');
    expect(prompt).not.toContain('- p40.mdx');
    expect(prompt).toContain('- … and 5 more in the split plan');
  });

  it('у других групп нет путей — так и сказано; без проверки — без раздела Proven', () => {
    const prompt = fixStagePrompt(['🟡 x'], { scope: { own: ['a.ts'], others: [] } });
    expect(prompt).toContain('No other group owns a path in the split plan.');
    expect(prompt).not.toContain('`Proven:`');
    expect(verifyStagePrompt({ findings: ['🟡 x'] })).not.toContain('Owned by OTHER groups');
  });
});
