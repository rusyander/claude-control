import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionHome } from './sessionHome.ts';

/**
 * Дом разговора после переезда в копию (Ф-6). Раскладка git собрана файлами —
 * ровно теми двумя, что читает `layoutForCwd` (`.git`-файл копии с `gitdir:`
 * и `commondir` в её служебном каталоге), без запуска git.
 */
describe('sessionHome', () => {
  let root = '';
  let main = '';
  let copy = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-home-'));
    main = join(root, 'app');
    copy = join(root, 'app-worktrees', 'agent-fix');
    const meta = join(main, '.git', 'worktrees', 'agent-fix');
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'commondir'), '../..\n');
    mkdirSync(join(copy, 'src'), { recursive: true });
    writeFileSync(join(copy, '.git'), `gitdir: ${meta}\n`);
    mkdirSync(join(main, 'sub'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('последний cwd в копии того же репозитория — дом копия', () => {
    expect(sessionHome(main, copy)).toBe(copy);
  });

  it('агент зашёл в подпапку копии — дом всё равно корень копии', () => {
    expect(sessionHome(main, join(copy, 'src'))).toBe(copy);
  });

  it('разговор из подпапки основного переехал в копию — дом копия', () => {
    expect(sessionHome(join(main, 'sub'), copy)).toBe(copy);
  });

  it('cd в подпапку основного — дом остаётся первым cwd', () => {
    expect(sessionHome(main, join(main, 'sub'))).toBe(main);
  });

  it('копию убрали — разговор возвращается в основную', () => {
    rmSync(copy, { recursive: true, force: true });
    expect(sessionHome(main, copy)).toBe(main);
  });

  it('копия чужого репозитория — не переезд', () => {
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });
    expect(sessionHome(other, copy)).toBe(other);
  });

  it('один cwd или ни одного — без изменений', () => {
    expect(sessionHome(main, undefined)).toBe(main);
    expect(sessionHome(undefined, copy)).toBeUndefined();
  });
});
