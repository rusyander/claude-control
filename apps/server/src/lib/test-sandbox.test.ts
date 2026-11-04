import { homedir, tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreHomeOf } from './hop-recorder.mjs';

/**
 * Песочница набора сервера (`vitest.temp-sandbox.ts`): тест не дотягивается до живого ядра этой
 * машины. 02–03.11 тест рантайма, запустивший чат, нашёл настоящий `~/.agentdeck/core` и завёл
 * там 28 задач — дом ядра по умолчанию должен лежать в каталоге прогона.
 */
describe('server test sandbox', () => {
  it('the default core home is inside the run temp, never the real ~/.agentdeck/core', () => {
    const home = coreHomeOf();
    expect(home).not.toBe(join(homedir(), '.agentdeck', 'core'));
    const inside = relative(tmpdir(), home);
    expect(inside.startsWith('..') || isAbsolute(inside), `${home} outside ${tmpdir()}`).toBe(
      false,
    );
  });
});
