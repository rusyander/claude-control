import { describe, expect, it } from 'vitest';
import { expandPathVars } from './path-vars.ts';

/**
 * PATH сервера с буквальными `%NVM_HOME%;%NVM_SYMLINK%` (g8 26.10): узел Node 22 выпадал из начала
 * PATH, первым шёл Node 24 из `C:\Program Files\nodejs`.
 */

const NVM = {
  NVM_HOME: String.raw`C:\Program Files\nvm`,
  NVM_SYMLINK: String.raw`C:\nvm4w\nodejs`,
};

describe('path-vars: нераскрытые %NAME% в PATH', () => {
  it('известные переменные раскрываются на месте, порядок каталогов сохраняется', () => {
    const env: NodeJS.ProcessEnv = {
      ...NVM,
      Path: String.raw`C:\WINDOWS;%NVM_HOME%;%nvm_symlink%;C:\Program Files\nodejs`,
    };
    expect(expandPathVars(env, 'win32')).toBe(true);
    expect(env.Path).toBe(
      String.raw`C:\WINDOWS;C:\Program Files\nvm;C:\nvm4w\nodejs;C:\Program Files\nodejs`,
    );
  });

  it('неизвестная переменная и значение с % остаются как были; вне Windows — ничего', () => {
    const env: NodeJS.ProcessEnv = { LOOP: '%LOOP%', PATH: String.raw`%MISSING%;%LOOP%;C:\bin` };
    expect(expandPathVars(env, 'win32')).toBe(false);
    expect(env.PATH).toBe(String.raw`%MISSING%;%LOOP%;C:\bin`);
    const posix: NodeJS.ProcessEnv = { ...NVM, PATH: '%NVM_HOME%:/usr/bin' };
    expect(expandPathVars(posix, 'linux')).toBe(false);
    expect(posix.PATH).toBe('%NVM_HOME%:/usr/bin');
  });
});
