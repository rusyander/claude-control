import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupCommandVerdict } from './group-command.ts';

/**
 * RF-BGCD-04: ссылка во временном уводит удаление наружу. `d=$(mktemp -d) &&
 * cmd //c mklink //J "$d\l" C:\work && rm -rf "$d/l/"*` шло уборкой свежего
 * каталога, а шаблон сносил файлы цели. Ссылка этой же команды делает путь ниже
 * неё чужим; ссылку, заведённую раньше, сверяет настоящий путь.
 */
describe('ссылки во временном и в рабочей папке — не уборка', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'links-')));
  const copy = join(base, 'shop-worktrees', 'fix-a');
  const pad = join(base, 'claude', 'proj', 'session', 'scratchpad');
  // Цель вне временного каталога: пустой каталог в `node_modules` пакета (не данные).
  const outside = realpathSync.native(
    mkdtempSync(join(process.cwd(), 'node_modules', '.links-outside-')),
  );
  const padLink = join(pad, 'l');
  const tempLink = join(tmpdir(), `${basename(base)}-l`);
  const slash = (path: string): string => path.replace(/\\/g, '/');
  const link = (target: string, path: string): void =>
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  const scope = { worktree: copy, cwd: copy, branch: 'fix/a', ignored: [], scratchpad: pad };
  const kind = (command: string): string => groupCommandVerdict(command, scope).kind;

  beforeAll(() => {
    mkdirSync(join(copy, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(copy, '.git'), 'gitdir: elsewhere\n');
    mkdirSync(join(pad, 'plain'), { recursive: true });
    link(outside, padLink);
    link(outside, tempLink);
  });
  afterAll(() => {
    // Ссылки — снять сами (не идя внутрь), затем каталоги.
    for (const path of [padLink, tempLink]) {
      try {
        unlinkSync(path);
      } catch {
        rmSync(path, { force: true });
      }
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('на диске: удаление по шаблону через ссылку сносит файлы цели', () => {
    const victim = join(base, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'data.txt'), 'keep\n');
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    link(victim, join(fresh, 'l'));
    execFileSync('bash', ['-c', `rm -rf "${slash(fresh)}/l/"*`]);
    expect(existsSync(join(victim, 'data.txt'))).toBe(false);
    unlinkSync(join(fresh, 'l'));
  });

  it.each([
    'd=$(mktemp -d) && cmd //c mklink //J "$d\\l" C:\\work && rm -rf "$d/l/"*',
    'd=$(mktemp -d) && cmd /c mklink /J d:\\x C:\\work && rm -rf "$d/l/"*',
    'd=$(mktemp -d) && ln -s /c/work "$d/l" && rm -rf "$d/l/"*',
    'd=$(mktemp -d) && ln -s /c/work "$d/l" && rm -rf "$d/l/x"',
    'd=$(mktemp -d) && ln -s /c/work "$d/l" && rm -rf "$d/l/"',
    'ln -s ../../.. .agent/tmp/l && rm -rf .agent/tmp/l/*',
    'ln -s /c/work .agent/tmp/l && cd .agent/tmp/l && rm -rf *',
    'ln -s /c/work .agent/tmp/ && rm -rf .agent/tmp/work/*',
    'ln -sfn ../fix-b .agent/tmp/l && git -C .agent/tmp/l reset --hard',
    'cp -rs /c/work .agent/tmp/m && rm -rf .agent/tmp/m/*',
    'pwsh -c "New-Item -ItemType Junction -Path x -Target C:\\work"; rm -rf .agent/tmp/x/*',
    'ln -s /c/work "$L" && rm -rf .agent/tmp/build/*',
  ])('ссылка этой же команды — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
  });

  it('ссылка, заведённая раньше в своей рабочей папке, — по настоящему пути', () => {
    expect(kind(`rm -rf "${slash(padLink)}/"*`)).toBe('danger');
    // Запись наружу — не уборка: идёт правилам чата, как любая запись вне копии.
    expect(kind(`echo x > "${slash(padLink)}/f.txt"`)).toBe('other');
    expect(kind(`echo x > "${slash(pad)}/f.txt"`)).toBe('routine');
    expect(kind(`rm -rf "${slash(pad)}/plain/"*`)).toBe('routine');
  });

  it('ссылка, заведённая раньше во временном каталоге, — запись туда не временная', () => {
    const name = basename(tempLink);
    expect(kind(`rm -rf /tmp/${name}/*`)).toBe('danger');
    expect(kind(`echo x > /tmp/${name}/f.log`)).toBe('other');
    expect(kind(`echo x > /tmp/${basename(base)}-plain.log`)).toBe('routine');
  });

  it.each([
    'd=$(mktemp -d) && rm -rf "$d"',
    'd=$(mktemp -d) && rm -rf "$d/"*',
    'rm -rf .agent/tmp/x',
    'rm -rf .agent/tmp/l',
    'echo y > .agent/tmp/x.txt',
  ])('без ссылки на пути — уборка: %s', (command) => {
    expect(kind(command)).toBe('routine');
  });
});
