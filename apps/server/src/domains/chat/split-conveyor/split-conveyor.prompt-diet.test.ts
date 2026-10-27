import { existsSync } from 'node:fs';
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

  it('пункты одного пробела — наставление один раз, номера списком; разный `why` — своей строкой (g0 F5)', () => {
    const unsourced = (point: string) => serverText('delivery-gap-task-unsourced', { point });
    const flip = (point: string, why: string) =>
      serverText('delivery-gap-task-flip', { point, why });
    const prompt = deliveryNudgePrompt('feature/users', [
      unsourced('task-1654'),
      unsourced('task-1655'),
      flip('task-1', 'run gone'),
      unsourced('task-1656'),
      flip('task-2', 'file moved'),
    ]);
    expect(prompt).toContain(
      '- task point task-1654 is pass with no source: quote the point itself word for word',
    );
    expect(prompt).toContain('— the same holds for task-1655, task-1656');
    expect(prompt.split('is pass with no source').length - 1).toBe(1);
    expect(prompt).toContain(
      '- task point task-1: the row turned pass with no new proof — run gone',
    );
    expect(prompt).toContain(
      '- task point task-2: the row turned pass with no new proof — file moved',
    );
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

/**
 * N1 (g3 25.10): описание MR и строки сит группа узнавала только следующим кругом
 * (~427k токенов за круг). Напоминание с такими пробелами называет команду, которой
 * группа сверит всё сама до ответа, — путём к настоящему `tests-cli.mjs`.
 */
describe('напоминание доставки: самопроверка до ответа', () => {
  const MR = 'https://git.example.com/team/app/-/merge_requests/1';
  const notes = serverText('delivery-gap-mr-notes', { mr: MR, items: 'browser-focus' });

  it('пробел описания MR — команда `tests-cli delivery` с путём к CLI панели', () => {
    const prompt = deliveryNudgePrompt('feature/users', [notes]);
    const command = /`node "([^"]+)" delivery --project \. --answer /.exec(prompt);
    expect(command?.[1]).toMatch(/[\\/]tools[\\/]tests-cli\.mjs$/);
    expect(existsSync(command?.[1] ?? '')).toBe(true);
    expect(deliveryPolicyIds([notes])).toContain('delivery-self-check');
    // F-14 (аудит g0 25.10): описание публикуют один раз и проверяют живое MR через панель,
    // а не пишут файлом для --mr-description и затем то же — в фордж.
    expect(prompt).toContain('post the MR description to the MR once');
    expect(prompt).not.toContain('--mr-description <file with the MR description>');
    // R5 (аудит g9 27.10): повторную публикацию страж набора пускает только после проверки черновика.
    expect(prompt).toContain('a description already posted that must change goes through it first');
  });

  it('переворот сита — отчётный пробел: без коммита и push, с самопроверкой', () => {
    const flip = serverText('sieve-gap-flip', { sieve: 'browser-focus', why: 'same' });
    const prompt = deliveryNudgePrompt('feature/users', [flip]);
    expect(prompt).toContain('Only the report is missing');
    expect(prompt).toContain('delivery --project .');
  });

  it('нет MR — самопроверки доставки нет (её нечем пройти до push)', () => {
    expect(deliveryPolicyIds([NO_MR])).not.toContain('delivery-self-check');
  });

  it('пробелы источника строк следа задач — отчётные: без коммита и push, только названные строки (g1 F3)', () => {
    const lines = [
      serverText('delivery-gap-task-unsourced', { point: 'task-1670' }),
      serverText('delivery-gap-task-quote-unfound', { point: 'task-1669', quote: 'чужая фраза' }),
      serverText('delivery-gap-task-quote-label', { point: 'task-1669', quote: 'qa-gl244' }),
      serverText('delivery-gap-task-rewritten', { point: 'task-1', was: 'a', now: 'b' }),
    ];
    for (const line of lines) {
      const prompt = deliveryNudgePrompt('feature/users', [line]);
      expect(prompt).toContain('Only the report is missing');
      expect(prompt).toContain('answer with only the rows named above');
      expect(prompt).not.toContain('Finish it with the delivery skill');
    }
  });

  it('заметки, что живое описание MR уже называет, — счётом, не текстом (g1 F4)', () => {
    const open = 'not checked: browser-focus — no stand';
    const named = 'not checked: mobile-layout — no device';
    const prompt = deliveryNudgePrompt('feature/users', [notes], [open, named], new Set(), [named]);
    expect(prompt).toContain(`- ${open}`);
    expect(prompt).not.toContain(named);
    expect(prompt).toContain('1 more note is already named in the live MR description');
  });

  it('самопроверка: выход 0 — доказательство описания и веток, перечитанный факт — в строку до прогона (g1 F6, F7)', () => {
    const prompt = deliveryNudgePrompt('feature/users', [notes]);
    expect(prompt).toContain('do not read them again through the forge');
    expect(prompt).toContain(
      'is written into that row first; run the check once, after the last row edit',
    );
  });
});
