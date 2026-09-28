import { describe, expect, it } from 'vitest';
import { runLabel } from './runLabel';

const WORDS = {
  mode: { import: 'импорт из CI', run: 'прогон агентом' },
  actor: { ci: 'CI', agent: 'агент' },
  e2e: 'автотесты панели',
  e2eActor: 'панель',
};

describe('runLabel', () => {
  it('автотесты панели подписаны своим именем, а не «импортом из CI»', () => {
    expect(runLabel({ mode: 'import', actor: 'ci', origin: 'e2e' }, WORDS)).toEqual({
      title: 'автотесты панели',
      actor: 'панель',
    });
  });

  it('импорт CI и старая запись без поля — «импорт из CI»; не импорт поле не читает', () => {
    const ci = { title: 'импорт из CI', actor: 'CI' };
    expect(runLabel({ mode: 'import', actor: 'ci', origin: 'ci' }, WORDS)).toEqual(ci);
    expect(runLabel({ mode: 'import', actor: 'ci' }, WORDS)).toEqual(ci);
    expect(runLabel({ mode: 'run', actor: 'agent', origin: 'e2e' }, WORDS)).toEqual({
      title: 'прогон агентом',
      actor: 'агент',
    });
  });
});
