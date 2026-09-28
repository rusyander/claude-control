import { describe, it, expect } from 'vitest';
import { knobCandidates, MAX_KNOB_CANDIDATES } from './knob-candidates.ts';

/**
 * Строки-кандидаты «чисел»: подсказка модели и сторож пустого ответа. Ложное
 * «нет кандидатов» возвращает старую беду (пустое «чисел нет» в кэше), ложное
 * «есть» — лишний переспрос, поэтому проверяются обе стороны.
 */

describe('строки-кандидаты чисел скилла', () => {
  it('находит счётчики цифрами и словами, по-английски и по-русски', () => {
    const lines = [
      '- exactly **two** review subagents in §9, nowhere else in the flow.',
      'Run 2 review rounds before the verdict.',
      'the same gate red three times on the same cause → stop and ask.',
      'Look at the pipeline exactly twice before the handoff.',
      'An infra death: retry that job **once**.',
      'Сверка с макетом — ревью двумя агентами.',
      'Если гейт упал три раза — остановиться.',
      'Проверяют трижды, по одной полосе на вход.',
    ];
    expect(knobCandidates(lines.join('\n'))).toEqual(lines);
  });

  it('проза с цифрами и словами-числами — не счётчик', () => {
    const text = [
      'Needs Node 22.6 and the stand on port 5173.',
      'See §9 and §4.2 for details.',
      'Once the MR is open, move the ticket to review.',
      'panel start the SAME run: one conveyor, identical every time.',
      'The run has one designed checkpoint.',
      'Разбор идёт в один проход по двум файлам конфигурации.',
      'Как раз тут лежит 3-й файл.',
    ].join('\n');
    // «один проход» — счётчик: единица рядом с проходом, а не с «run»/«time».
    expect(knobCandidates(text)).toEqual([
      'Разбор идёт в один проход по двум файлам конфигурации.',
    ]);
  });

  it('повторы убраны, длина строки — как у цитаты, число строк ограничено', () => {
    const long = `Spawn 3 agents per round. ${'x'.repeat(400)}`;
    expect(knobCandidates(`${long}\n${long}`)).toEqual([long.slice(0, 200)]);
    const many = Array.from({ length: 40 }, (_, i) => `Step ${i}: run 2 agents.`).join('\n');
    expect(knobCandidates(many)).toHaveLength(MAX_KNOB_CANDIDATES);
  });
});
