import { describe, expect, it } from 'vitest';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { HUMAN_ONLY_LINE } from '../split-continue.ts';
import {
  deliveryNudgePrompt,
  deliveryPolicyIds,
  interruptResumePrompt,
  limitResumePrompt,
  pauseResumePrompt,
} from './split-conveyor.ts';
import { harness, NO_MR } from './split-conveyor.escalation.fixture.ts';

/**
 * Диета слов круга доставки (группа 1, 25.10): десять напоминаний в одном разговоре
 * несли по ~2,2k знаков тех же правил, а шесть сит на один путь — шесть строк по
 * ~530 знаков. Правила — полным текстом один раз на разговор, сита на один путь —
 * одной строкой. Продолжения не противоречат блоку фактов панели.
 */

const stale = (sieve: string, files: string) => serverText('sieve-gap-stale', { sieve, files });
const INVESTIGATE_HEAD = 'For every line above, find the cause with your own tools';

describe('напоминание доставки: правила один раз на разговор', () => {
  it('первое — полным текстом; с `given` — одной строкой «всё ещё в силе»', () => {
    const full = deliveryNudgePrompt('feature/users', [NO_MR]);
    expect(full).toContain(HUMAN_ONLY_LINE);
    expect(full).toContain(INVESTIGATE_HEAD);
    const given = new Set(deliveryPolicyIds([NO_MR]));
    const short = deliveryNudgePrompt('feature/users', [NO_MR], [], given);
    expect(short).not.toContain(HUMAN_ONLY_LINE);
    expect(short).not.toContain(INVESTIGATE_HEAD);
    expect(short).toMatch(/Still in force from the panel’s earlier reminder .*ask the human only/);
    // Пробелы и шаг доставки — каждый раз полностью.
    expect(short).toContain('open the MR yourself');
    expect(full.length - short.length).toBeGreaterThan(1_500);
  });

  it('новое правило (другой вид пробела) приходит полным текстом и во втором слове', () => {
    const given = new Set(deliveryPolicyIds([NO_MR]));
    const next = deliveryNudgePrompt(
      'feature/users',
      [NO_MR, stale('project-checks', 'a.ts')],
      [],
      given,
    );
    expect(next).toContain('one row for every sieve line above');
  });

  it('сита на один путь — одной строкой, на разные — каждое своей', () => {
    const prompt = deliveryNudgePrompt('feature/users', [
      stale('consumers-repo-wide', 'src/guard.tsx'),
      stale('project-checks', 'src/guard.tsx'),
      stale('contract-by-request', 'src/other.ts'),
    ]);
    expect(prompt).toContain(
      '- sieves consumers-repo-wide, project-checks: the branch changed the code these sieves cover after their rows were reported (src/guard.tsx)',
    );
    expect(prompt).toContain('- sieve contract-by-request: the branch changed the code');
    expect(prompt.split('src/guard.tsx').length - 1).toBe(1);
  });
});

describe('конвейер: второе слово в тот же разговор — без повтора правил', () => {
  it('сессия работы: первое напоминание полное, второе — короткое', async () => {
    const h = harness(
      [
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h2' },
        { missing: [NO_MR], head: 'h2' },
      ],
      { stage: 'work' },
    );
    await h.start();
    await h.round();
    await h.round();
    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'nudge']);
    expect(h.words[0]?.prompt).toContain(HUMAN_ONLY_LINE);
    expect(h.words[1]?.prompt).not.toContain(HUMAN_ONLY_LINE);
    expect(h.words[1]?.prompt).toContain('Still in force');
  });

  it('правила копятся по разговору: отданное двумя словами раньше не повторяется', async () => {
    const staleRow = stale('project-checks', 'src/a.ts');
    const h = harness(
      [
        { missing: [staleRow], head: 'h1' },
        { missing: [staleRow], head: 'h1' },
        { missing: [NO_MR], head: 'h2' },
        { missing: [NO_MR], head: 'h2' },
        { missing: [staleRow], head: 'h3' },
        { missing: [staleRow], head: 'h3' },
      ],
      { stage: 'work' },
    );
    await h.start();
    await h.round();
    await h.round();
    await h.round();
    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'nudge', 'nudge']);
    const SIEVE_HINT = 'one row for every sieve line above';
    expect(h.words[0]?.prompt).toContain(SIEVE_HINT);
    expect(h.words[2]?.prompt).not.toContain(SIEVE_HINT);
    expect(h.words[2]?.prompt).toContain('a sieves-block row for every sieve line');
  });

  it('новый разговор доставки — полным текстом, следующее слово в него — короткое', async () => {
    const h = harness(
      [
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h2' },
        { missing: [NO_MR], head: 'h2' },
      ],
      { stage: 'review' },
    );
    await h.start();
    await h.round();
    await h.round();
    expect(h.words.map((word) => word.via)).toEqual(['deliver', 'nudge']);
    expect(h.words[0]?.prompt).toContain(HUMAN_ONLY_LINE);
    expect(h.words[1]?.prompt).not.toContain(HUMAN_ONLY_LINE);
    expect(h.group()?.deliveryPolicy?.chat).toBe('new-deliver');
  });
});

describe('продолжения не спорят с блоком фактов панели', () => {
  it('ни одно не велит собрать git заново, когда блок фактов есть', () => {
    for (const prompt of [
      interruptResumePrompt('feature/users'),
      limitResumePrompt('feature/users'),
      pauseResumePrompt('feature/users'),
    ]) {
      expect(prompt).not.toContain('(git status, git log, your transcript)');
      expect(prompt).not.toContain('from the facts: git status, git log');
      expect(prompt).toContain('current as of its timestamp');
    }
  });
});
