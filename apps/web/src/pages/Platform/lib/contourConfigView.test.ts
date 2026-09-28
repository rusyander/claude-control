import { describe, expect, it } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts';
import type { Platform, PlatformConsumerOption, PlatformRuleConflict } from '@agentdeck/contracts';
import {
  overlapSummary,
  overlapsByOurRule,
  overlapsByPlatformRule,
  ourOverlapName,
  rulesAppliesOf,
  sectionRows,
  sideOff,
  toolExclusionLocks,
  winnerKey,
  withApplies,
} from './contourConfigView';

const PLATFORM = {
  id: 'company-dev',
  title: 'Company · dev',
  consumers: ['chat', 'assistant'],
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
} as unknown as Platform;

const cell = (over: Partial<PlatformRuleConflict>): PlatformRuleConflict => ({
  id: 'tools',
  level: 'exclusive',
  platformRule: 'platform_tools',
  ourRule: 'toolShim',
  title: '',
  detail: '',
  active: false,
  ...over,
});

describe('разделы на карточке', () => {
  it('без плана — встроенные разделы по сохранённому выбору', () => {
    const rows = sectionRows(PLATFORM, undefined);
    expect(rows.map((row) => [row.id, row.open, row.opensHere])).toEqual([
      ['chat', true, true],
      ['groups', false, true],
      ['tests', false, true],
      ['assistant', true, false],
      ['terminal', false, false],
    ]);
  });

  it('из плана: чужой CLI открывается на карточке, недоступный закрыт с причиной', () => {
    const options: PlatformConsumerOption[] = [
      { id: 'chat', title: '', selected: true, scope: 'run' },
      { id: 'foreign:qwen', title: 'Qwen Code', selected: false, scope: 'run' },
      {
        id: 'foreign:codex',
        title: 'Codex',
        selected: false,
        scope: 'files',
        reason: 'file_only',
      },
    ];
    const rows = sectionRows({ ...PLATFORM, consumers: ['chat', 'foreign:codex'] }, options);
    expect(rows[1]).toMatchObject({ kind: 'foreign', name: 'Qwen Code', opensHere: true });
    // Сохранённый мимо мастера недоступный раздел открытым не показывается.
    expect(rows[2]).toMatchObject({ open: false, reason: 'file_only', opensHere: false });
  });
});

describe('чьи правила действуют', () => {
  it('нет поля или мусор — оба набора', () => {
    expect(rulesAppliesOf(PLATFORM)).toBe('both');
    const junk = {
      ...PLATFORM,
      rules: { ...PLATFORM.rules, applies: 'всё' },
    } as unknown as Platform;
    expect(rulesAppliesOf(junk)).toBe('both');
  });

  it('выбор пишется рядом со сторонами и не трогает их значения', () => {
    const next = withApplies(PLATFORM, 'ours');
    expect(next.rules.applies).toBe('ours');
    expect(next.rules.platform).toBe(PLATFORM.rules.platform);
    expect(next.rules.ours).toBe(PLATFORM.rules.ours);
    expect(sideOff('ours')).toEqual({ contour: true, ours: false });
    expect(sideOff('contour')).toEqual({ contour: false, ours: true });
    expect(sideOff('both')).toEqual({ contour: false, ours: false });
  });
});

describe('кто берёт верх', () => {
  it('у известной ячейки своя фраза, у незнакомой — по победителю, без победителя — ничего', () => {
    expect(winnerKey(cell({ winner: 'contour' }))).toBe('contourConfig.winner.tools');
    expect(winnerKey(cell({ id: 'new-cell', winner: 'both' }))).toBe('contourConfig.winner.both');
    expect(winnerKey(cell({}))).toBeUndefined();
  });

  it('пересечения находятся с обеих сторон, спор снятой стороны не считается', () => {
    const cells = [
      cell({ active: true }),
      cell({
        id: 'guardrails',
        platformRule: 'guardrails',
        ourRule: 'promptGate',
        active: true,
        offBy: 'ours',
      }),
    ];
    expect(overlapsByPlatformRule(cells).get('guardrails')?.id).toBe('guardrails');
    expect(overlapsByOurRule(cells).get('toolShim')?.id).toBe('tools');
    expect(overlapSummary(cells)).toEqual({ total: 2, active: 1 });
    expect(ourOverlapName('dlp')).toBe('dlp');
    expect(ourOverlapName('нечто')).toBeUndefined();
  });
});

// Ревью 28.09 F-82: карточка запирала прослойку по ЗАПИСАННОМУ набору
// инструментов контура, а сервер (`brokenExclusion`) судит по ДЕЙСТВУЮЩЕМУ: при
// «Только наши» набор контура в прогон не идёт, и замок стоял зря.
describe('взаимное исключение набора контура и прослойки', () => {
  const withTools = (applies: 'both' | 'ours' | 'contour', toolShim: boolean): Platform =>
    ({
      ...PLATFORM,
      toolShim,
      rules: {
        applies,
        platform: { ...defaultPlatformRules(), platformTools: ['search'] },
        ours: defaultOurRules(),
      },
    }) as unknown as Platform;

  it('«Только наши»: набор контура записан, но не действует — прослойка не заперта', () => {
    expect(toolExclusionLocks(withTools('ours', false))).toEqual({
      shimLocked: false,
      toolsLocked: false,
    });
  });

  it('«Оба» и «Только контура»: действующий набор запирает прослойку, как на сервере', () => {
    expect(toolExclusionLocks(withTools('both', false)).shimLocked).toBe(true);
    expect(toolExclusionLocks(withTools('contour', false)).shimLocked).toBe(true);
  });

  it('прослойка включена, набора нет — добавить набор нельзя, пока он действовал бы', () => {
    const empty = (applies: 'both' | 'ours'): Platform =>
      ({
        ...PLATFORM,
        toolShim: true,
        rules: { applies, platform: defaultPlatformRules(), ours: defaultOurRules() },
      }) as unknown as Platform;
    expect(toolExclusionLocks(empty('both')).toolsLocked).toBe(true);
    expect(toolExclusionLocks(empty('ours')).toolsLocked).toBe(false);
  });
});
