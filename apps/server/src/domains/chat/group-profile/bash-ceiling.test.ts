import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashCeilingMs, bashCeilingsAt } from './bash-ceiling.ts';

/**
 * 3.1 плана экономии, ревью B-F02/B-F04: потолок Bash группы едет настройками
 * флага и обязан не занизить больший, уже действующий у человека.
 */
describe('bashCeilingsAt', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-bash-ceiling-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const put = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('личные, проектные, локальные настройки и окружение панели — все в счёт', () => {
    const user = join(root, 'home', 'settings.json');
    const cwd = join(root, 'proj');
    put(user, { env: { BASH_MAX_TIMEOUT_MS: '600000' } });
    put(join(cwd, '.claude', 'settings.json'), { env: { BASH_MAX_TIMEOUT_MS: 2_400_000 } });
    put(join(cwd, '.claude', 'settings.local.json'), { env: { OTHER: '1' } });
    const found = bashCeilingsAt(user, cwd, { BASH_MAX_TIMEOUT_MS: '900000' });
    expect(found).toEqual(['600000', '2400000', undefined, '900000']);
    expect(bashCeilingMs(found)).toBe(2_400_000);
  });

  it('битый и пустой файл не в счёт и не бросают: профиль группы не теряется', () => {
    const user = join(root, 'home', 'settings.json');
    const cwd = join(root, 'proj');
    put(user, '{ not json');
    put(join(cwd, '.claude', 'settings.json'), '');
    expect(bashCeilingsAt(user, cwd, {})).toEqual([undefined, undefined, undefined, undefined]);
    expect(bashCeilingMs(bashCeilingsAt(user, cwd, {}))).toBe(1_800_000);
  });
});
