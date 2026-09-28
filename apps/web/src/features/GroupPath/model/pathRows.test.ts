import { describe, expect, it } from 'vitest';
import type { KnobView, PathEntry } from '@agentdeck/contracts';
import { buildPathRows, canInsertAfter, ownStepCount } from './pathRows';
import { firstParagraph, skillTextSteps, stepOfQuote } from './skillText';
import { rowHint, rowText } from './describe';
import { isAutoKnob, knobEditValue, knobNumbers, knobSelectValue, KNOB_AUTO } from './knobs';
import { entrySource, joinPath, skillSource, sourceFile } from './stepSource';

const SKILL = [
  '---',
  'name: fleet-review',
  '---',
  'Intro: rounds depend on size, ≤100 files → 2 lanes.',
  '',
  '## 1. Prepare',
  'Collect the diff.',
  '',
  '```',
  '## 9. Not a step (inside a fence)',
  '```',
  '## 2. Review',
  'Run 3 rounds; each round has 2 agents.',
  '',
  'Second paragraph.',
  '### Notes',
  'Nested heading stays inside the step.',
  '## Appendix',
  'Verifiers: 1 per round.',
].join('\n');

function knob(key: string, quote: string, patch: Partial<KnobView> = {}): KnobView {
  return {
    key,
    skillId: 'fleet-review',
    label: { ru: key, en: key },
    default: 2,
    min: 1,
    max: 4,
    quote,
    value: 2,
    auto: true,
    overridden: false,
    ...patch,
  };
}

const ENTRIES: PathEntry[] = [
  { kind: 'builtin', stage: 'triage' },
  { kind: 'builtin', stage: 'work' },
  { kind: 'skill-step', skillId: 'fleet-review', index: 0, title: 'Prepare' },
  { kind: 'skill-step', skillId: 'fleet-review', index: 1, title: 'Review' },
  { kind: 'builtin', stage: 'review' },
];

describe('skillTextSteps — зеркало серверного skillSteps', () => {
  it('берёт пронумерованные заголовки по возрастанию, пропуская блоки кода', () => {
    const steps = skillTextSteps(SKILL);
    expect(steps.map((step) => step.title)).toEqual(['Prepare', 'Review']);
    expect(steps[1]?.body).toContain('Nested heading stays inside the step.');
    // Заголовок не глубже шага закрывает раздел.
    expect(steps[1]?.body).not.toContain('Verifiers');
  });

  it('один пронумерованный заголовок — не порядок работы', () => {
    expect(skillTextSteps('## 1. Only\ntext')).toEqual([]);
  });

  it('цитата в разделе даёт шаг, во вступлении и вне разделов — нет', () => {
    const steps = skillTextSteps(SKILL);
    expect(stepOfQuote(steps, SKILL, 'Run 3 rounds')).toBe(1);
    expect(stepOfQuote(steps, SKILL, '≤100 files → 2 lanes')).toBeUndefined();
    expect(stepOfQuote(steps, SKILL, 'Verifiers: 1 per round.')).toBeUndefined();
    expect(stepOfQuote(steps, SKILL, 'absent')).toBeUndefined();
  });

  it('первый абзац без заголовков и с обрезкой', () => {
    expect(firstParagraph('Run 3 rounds.\n\nSecond.')).toBe('Run 3 rounds.');
    expect(firstParagraph('x'.repeat(400), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('buildPathRows', () => {
  it('число встаёт на шаг своей цитаты, без раздела — на первый шаг скилла', () => {
    const rows = buildPathRows(
      ENTRIES,
      [knob('rounds', 'Run 3 rounds'), knob('lanes', '≤100 files → 2 lanes')],
      () => SKILL,
    );
    expect(rows.map((row) => [row.key, row.knobs.map((item) => item.key)])).toEqual([
      ['builtin:triage', []],
      ['builtin:work', []],
      ['skill:fleet-review:0:2', ['lanes']],
      ['skill:fleet-review:1:3', ['rounds']],
      ['builtin:review', []],
    ]);
  });

  it('текста нет (скилл проекта) — все числа на первом шаге скилла', () => {
    const rows = buildPathRows(ENTRIES, [knob('rounds', 'Run 3 rounds')], () => undefined);
    expect(rows[2]?.knobs.map((item) => item.key)).toEqual(['rounds']);
    expect(rows[3]?.knobs).toEqual([]);
  });

  it('шаг от сервера (скилл проекта, текста у страницы нет) — число на этом шаге', () => {
    const rows = buildPathRows(
      ENTRIES,
      [knob('rounds', 'Run 3 rounds', { step: 1 })],
      () => undefined,
    );
    expect(rows[2]?.knobs).toEqual([]);
    expect(rows[3]?.knobs.map((item) => item.key)).toEqual(['rounds']);
  });

  it('скилл без шагов в пути получает строку «целиком» после блока скиллов', () => {
    const rows = buildPathRows(
      ENTRIES,
      [knob('agents', 'x', { skillId: 'deep-review' })],
      () => undefined,
    );
    expect(rows.map((row) => row.key)).toEqual([
      'builtin:triage',
      'builtin:work',
      'skill:fleet-review:0:2',
      'skill:fleet-review:1:3',
      'whole:deep-review',
      'builtin:review',
    ]);
    // «+» после такой строки вставляет шаг после последнего шага скиллов.
    expect(rows[4]).toMatchObject({ kind: 'skill', entryIndex: 3 });
  });

  it('скилл, вошедший шагом-ссылкой (сценарий), несёт свои числа в этой строке', () => {
    const reference: PathEntry = {
      kind: 'custom',
      step: {
        id: 'ref',
        anchor: 'work',
        order: 0,
        kind: 'resource',
        resource: { type: 'skill', id: 'deep-review' },
        title: { ru: 'Ревью', en: 'Review' },
        prompt: { ru: '', en: '' },
        source: 'ru',
        createdAt: 'now',
      },
    };
    const rows = buildPathRows(
      [reference],
      [knob('agents', 'x', { skillId: 'deep-review' })],
      () => undefined,
    );
    expect(rows.map((row) => row.key)).toEqual(['custom:ref']);
    expect(rows[0]?.knobs.map((item) => item.key)).toEqual(['agents']);
  });

  it('«+» между любыми строками, кроме как перед строкой «скилл целиком»', () => {
    const rows = buildPathRows(
      ENTRIES,
      [knob('agents', 'x', { skillId: 'deep-review' })],
      () => undefined,
    );
    // triage, work, step0, step1, whole, review: под «Работой» и между шагами
    // скилла — вставка внутрь его порядка; перед «скилл целиком» — нет.
    expect(rows.map((_, index) => canInsertAfter(rows, index))).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('без чисел — ровно строки сервера; число шагов — без встроенных стадий', () => {
    expect(buildPathRows(ENTRIES, [], () => SKILL)).toHaveLength(ENTRIES.length);
    expect(ownStepCount(ENTRIES)).toBe(2);
  });
});

describe('числа: «Авто» и закреплённое', () => {
  it('«Авто» — значение списка auto, закреплённое — само число, даже равное умолчанию', () => {
    expect(knobSelectValue(knob('a', 'q'))).toBe(KNOB_AUTO);
    const pinned = knob('a', 'q', { auto: false, value: 2 });
    expect(isAutoKnob(pinned)).toBe(false);
    expect(knobSelectValue(pinned)).toBe('2');
  });

  it('выбор в списке → тело PUT: auto → null, число → число', () => {
    expect(knobEditValue(KNOB_AUTO)).toBeNull();
    expect(knobEditValue('3')).toBe(3);
    expect(knobNumbers({ min: 1, max: 4 })).toEqual([1, 2, 3, 4]);
  });
});

describe('откуда строка и где её файл', () => {
  const global = { members: [{ kind: 'skill' as const, id: 'fleet-review' }] };
  const project = {
    scope: { kind: 'project' as const, path: 'C:\\work\\shop', provider: 'claude' },
    members: [{ kind: 'skill' as const, id: 'ticket' }],
  };
  const ours = new Set(['fleet-review']);

  it('наш, чужой, проекта, плагина; до загрузки списка — просто скилл', () => {
    expect(skillSource('fleet-review', { group: global, ourSkills: ours }).kind).toBe('our-skill');
    expect(skillSource('gone', { group: global, ourSkills: ours }).kind).toBe('foreign-skill');
    expect(skillSource('ticket', { group: project, ourSkills: ours }).kind).toBe('project-skill');
    expect(skillSource('figma:use', { group: global, ourSkills: ours })).toMatchObject({
      kind: 'plugin-skill',
      plugin: 'figma',
    });
    expect(skillSource('x', { group: global, ourSkills: undefined }).kind).toBe('skill');
  });

  it('свой шаг — промпт панели, превращённый — его ресурс', () => {
    const context = { group: global, ourSkills: ours };
    const step = {
      id: 's',
      anchor: 'review' as const,
      order: 0,
      kind: 'prompt' as const,
      title: { ru: 'Т', en: 'T' },
      prompt: { ru: 'Р', en: 'E' },
      source: 'ru' as const,
      createdAt: '',
    };
    expect(entrySource({ kind: 'custom', step }, context).kind).toBe('prompt');
    expect(
      entrySource(
        { kind: 'custom', step: { ...step, resource: { type: 'hook', id: 'h' } } },
        context,
      ),
    ).toMatchObject({ kind: 'hook', id: 'h' });
  });

  it('пути: разделитель основы, у чужого и плагина пути нет', () => {
    const paths = {
      skills: 'C:\\Users\\u\\.claude\\skills',
      settings: 'C:\\Users\\u\\.claude\\settings.json',
      claudeMd: 'C:\\Users\\u\\.claude\\CLAUDE.md',
      appData: 'C:\\Users\\u\\.claude\\agentdeck',
      hooks: 'C:\\Users\\u\\.claude\\hooks',
    };
    expect(sourceFile({ kind: 'our-skill', id: 'a' }, paths)).toBe(
      'C:\\Users\\u\\.claude\\skills\\a\\SKILL.md',
    );
    expect(sourceFile({ kind: 'foreign-skill', id: 'a' }, paths)).toBeUndefined();
    expect(sourceFile({ kind: 'plugin-skill', id: 'p:a' }, paths)).toBeUndefined();
    expect(sourceFile({ kind: 'script', id: 'check.mjs' }, paths)).toBe(
      'C:\\Users\\u\\.claude\\hooks\\check.mjs',
    );
    expect(sourceFile({ kind: 'prompt' }, paths)).toBe(
      'C:\\Users\\u\\.claude\\agentdeck\\state.json',
    );
    expect(sourceFile({ kind: 'hook', id: 'h' }, paths, '/s/lint.sh')).toBe('/s/lint.sh');
    expect(
      sourceFile(
        { kind: 'project-skill', id: 't', project: '/w/shop', provider: 'claude' },
        undefined,
      ),
    ).toBe('/w/shop/.claude/skills/t/SKILL.md');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });
});

describe('описание строки', () => {
  const known = new Map([['fleet-review', { description: 'Fleet review.', body: SKILL }]]);

  it('шаг скилла — его раздел дословно, подсказка — первый абзац', () => {
    const [, , , review] = buildPathRows(ENTRIES, [], () => SKILL);
    const text = rowText(review!, known, 'ru');
    expect(text).toMatchObject({ kind: 'text' });
    expect(text.kind === 'text' && text.text).toContain('Second paragraph.');
    expect(rowHint(text)).toEqual({ kind: 'text', text: 'Run 3 rounds; each round has 2 agents.' });
  });

  it('скилла нет в списке — сводка сервера; стадия — её подсказка', () => {
    const [first, , prepare] = buildPathRows(ENTRIES, [], () => undefined);
    expect(rowText(prepare!, new Map(), 'ru')).toEqual({
      kind: 'summary',
      type: 'skill',
      id: 'fleet-review',
    });
    expect(rowText(first!, known, 'ru')).toEqual({ kind: 'stage', stage: 'triage' });
  });
});
