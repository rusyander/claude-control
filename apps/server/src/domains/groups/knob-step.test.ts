import { describe, expect, it } from 'vitest';
import { skillStepHeadings } from '@agentdeck/contracts/skill-steps';
import { knobStep } from './knob-step.ts';
import { stepHeadings } from './path.ts';

/**
 * Форма скилла доставки тикета: вступление с правилами, нумерованные шаги, хвостовые
 * разделы после последнего шага. Числа ревью и правок обязаны встать на свои
 * шаги, а не на первый.
 */
const SKILL = [
  '---',
  'name: delivery',
  '---',
  '# Ticket → MR',
  '',
  '## Standing authorisations',
  'Use exactly **two** review subagents in §3, nowhere else in the flow.',
  '',
  '## 1. Read the ticket',
  'Read it once.',
  '',
  '## 2. The gates — in order',
  'The same gate red three times on the same cause → stop and ask.',
  '',
  '## 3. Deep review',
  'Run the review.',
  '',
  '## 4. Pipeline',
  'Retry that job **once**.',
  '',
  '## Red flags',
  'Never push five times in a row.',
].join('\n');

describe('шаг числа скилла', () => {
  it('цитата внутри шага — этот шаг, с разметкой и регистром как в тексте', () => {
    expect(knobStep(SKILL, 'the same gate red three times on the same cause')).toBe(1);
    expect(knobStep(SKILL, 'Retry that job once.')).toBe(3);
  });

  it('цитата во вступлении, называющая шаг «§3», — этот шаг', () => {
    expect(knobStep(SKILL, 'exactly two review subagents in §3')).toBe(2);
  });

  it('хвостовой раздел после шагов не приписан последнему шагу', () => {
    expect(knobStep(SKILL, 'Never push five times in a row.')).toBeUndefined();
  });

  // Ревью 28.09 (F-222): бралось первое вхождение цитаты — та же фраза во
  // вступлении ставила число мимо шага, где оно на самом деле живёт.
  it('та же фраза во вступлении не уводит число с его шага', () => {
    const text = SKILL.replace(
      '## Standing authorisations\n',
      '## Standing authorisations\nRetry that job **once**.\n',
    );
    expect(knobStep(text, 'Retry that job once.')).toBe(3);
  });

  it('цитаты нет в тексте или шагов нет — шаг не определён', () => {
    expect(knobStep(SKILL, 'not in the text at all')).toBeUndefined();
    expect(knobStep('# Plain\n\nRun two agents.', 'Run two agents.')).toBeUndefined();
  });
});

// Ревью 28.09 (F-230, паритет со страницей): разбор теперь один на сервер и
// страницу (`@agentdeck/contracts/skill-steps`). Два случая, где сервер сам был неправ.
describe('шаг числа — общий разбор', () => {
  it('«#» внутри блока кода не закрывает раздел шага', () => {
    const text = [
      '## 1. Prepare',
      '```bash',
      '# install deps',
      '```',
      'Retry 3 times.',
      '## 2. Review',
      'y',
    ].join('\n');
    expect(knobStep(text, 'Retry 3 times.')).toBe(0);
  });

  it('вступление называет шаг по-русски — «шаг 2»', () => {
    const text = ['Два агента на шаг 2.', '', '## 1. Prepare', 'x', '## 2. Review', 'y'].join('\n');
    expect(knobStep(text, 'Два агента')).toBe(1);
  });

  // Номер шага числа — индекс в строках пути сервера (`stepHeadings`), а страница
  // считает шаги общим разбором: заголовки обязаны совпасть до строки.
  it('шаги общего разбора совпадают с шагами пути сервера', () => {
    const corpus = [
      SKILL,
      ['## 3. A', 'a', '## 1. B', 'b', '## 2. C', 'c', '## 4. D', 'd'].join('\n'),
      ['## 1. P', '````md', '~~~', '## 9. X', '```', '## 8. Y', '````', '## 2. R'].join('\n'),
      ['### Step 1: One', '#### шаг 2 — Два', '## 3) Three ##', '# 4. Top level'].join('\r\n'),
      ['## 1. Only', 'text'].join('\n'),
      '',
    ];
    for (const text of corpus) {
      expect(skillStepHeadings(text)).toEqual(stepHeadings(text));
    }
  });
});
