import { describe, expect, it } from 'vitest';
import { switchAnswerOf } from './answers.ts';

/** Прежний разбор, который заменён без регулярки (P32): поведение обязано совпасть. */
function legacy(answer: string | undefined) {
  const m = answer === undefined ? null : /^(model|cli):(.+)$/.exec(answer);
  if (!m?.[2]) return null;
  return { field: m[1] === 'cli' ? 'adapter' : 'model', value: m[2] };
}

describe('switchAnswerOf — ответ-переключение модели или CLI', () => {
  const cases: (string | undefined)[] = [
    undefined,
    '',
    'model:',
    'cli:',
    'model:sonnet',
    'cli:codex',
    'model:a:b',
    'model: spaced',
    'Model:sonnet',
    ' model:sonnet',
    'models:sonnet',
    'cli',
    'model:x\ny',
    'model:x\r',
    'model:x ',
    'model:x y',
    'Продолжить',
  ];

  it.each(cases.map((answer) => [JSON.stringify(answer), answer]))(
    'совпадает с прежним разбором на %s',
    (_label, answer) => {
      expect(switchAnswerOf(answer)).toEqual(legacy(answer));
    },
  );

  it('cli: — правка CLI задачи, model: — правка модели', () => {
    expect(switchAnswerOf('cli:codex')).toEqual({ field: 'adapter', value: 'codex' });
    expect(switchAnswerOf('model:a:b')).toEqual({ field: 'model', value: 'a:b' });
  });
});
