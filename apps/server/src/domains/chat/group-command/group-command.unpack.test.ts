import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupDecision } from '../group-permissions.ts';
import { groupCommandVerdict } from './group-command.ts';

/**
 * RF-BGCD-04, раунд 6 (решение координатора 24.10). Два класса того, что обход
 * не может учесть, — решает человек:
 * 1. содержимое, созданное ЭТОЙ же командой (ссылки и распакованный архив):
 *    шаг, идущий сквозь него (`D/x/`, `D/x/*`, `D/*`, запись в `D/x`), — человеку;
 *    `rm -rf D` и `rm -rf D/x` ссылку не открывают — сами;
 * 2. ссылки на диске, которых не видит `realpath`: MSYS `winsymlinks:sys|lnk`
 *    (файл `!<symlink>` и ярлык `.lnk`), `rm`/`bash` Git Bash идут по ним наружу.
 * Распакованное прошлой командой сверяет живая проверка настоящего пути.
 */
const slash = (path: string): string => path.replace(/\\/g, '/');
/** Настоящий Git Bash; `MSYS` — каким видом ссылки он пишет `ln -s` и `tar -x`. */
const bash = (script: string, cwd: string, msys?: string): string =>
  execFileSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(msys ? { MSYS: msys } : {}) },
  });

describe('распакованный архив и невидимые ссылки — не уборка', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'unpack-')));
  const copy = join(base, 'shop-worktrees', 'fix-a');
  const pad = join(base, 'claude', 'proj', 'session', 'scratchpad');
  const victim = join(base, 'victim');
  const scope = { worktree: copy, cwd: copy, branch: 'fix/a', ignored: [], scratchpad: pad };
  const group = {
    rows: { ...GROUP_REQUEST_DEFAULTS },
    allowEdits: true,
    worktree: copy,
    base: 'main',
    ownBranch: 'fix/a',
    ignored: [],
    shellCwd: copy,
    scratchpad: pad,
    parentChatId: 'p',
    groupIndex: 0,
    tree: { dirty: false as const },
  };
  const decide = (command: string): string =>
    groupDecision(group, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
  const kind = (command: string): string => groupCommandVerdict(command, scope).kind;
  const refill = (): void => {
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'data.txt'), 'keep\n');
  };

  beforeAll(() => {
    mkdirSync(join(copy, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(copy, '.git'), 'gitdir: elsewhere\n');
    mkdirSync(join(base, 'src'), { recursive: true });
    mkdirSync(pad, { recursive: true });
    refill();
    // Архив со ссылкой `l` → victim: настоящий tar, ссылка MSYS (без прав на ссылки Windows).
    bash(`ln -s "${slash(victim)}" src/l && tar -cf evil.tar -C src l`, base, 'winsymlinks:sys');
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('на диске: настоящий tar распаковывает ссылку, и удаление сквозь неё сносит цель', () => {
    expect(bash('tar -tvf evil.tar', base)).toMatch(/^l.* l -> /m);
    const into = join(base, 'live-1');
    mkdirSync(into);
    bash(
      `tar -xf evil.tar -C "${slash(into)}" && rm -rf "${slash(into)}/l/"*`,
      base,
      'winsymlinks:sys',
    );
    expect(existsSync(join(victim, 'data.txt'))).toBe(false);
    refill();
  });

  it.each([
    // из списка ревью
    'd=$(mktemp -d) && tar -xf evil.tar -C "$d" && rm -rf "$d/l/"*',
    'tar -xzf a.tgz -C .agent/tmp/x && rm -rf .agent/tmp/x/pkg/',
    'unzip -q a.zip -d .agent/tmp/u && rm -rf .agent/tmp/u/x/*',
    '7z x a.7z -o.agent/tmp/z && rm -rf .agent/tmp/z/a/b',
    'bsdtar -xf a.zip -C .agent/tmp/b && rm -rf .agent/tmp/b/*/c',
    'cd .agent/tmp/x && tar xf ../a.tar && rm -rf sub/*',
    'd=$(mktemp -d) && tar -xf a.tar -C "$d" && rm -rf "$d/"*',
    // запись сквозь распакованное
    'tar -xzf a.tgz -C .agent/tmp/x && echo hi > .agent/tmp/x/f.txt',
    'tar -xzf a.tgz -C .agent/tmp/x && cp a.txt .agent/tmp/x/sub/',
    'tar xzf a.tgz && echo done >> out.txt',
    // не из списка ревью
    'git archive HEAD | tar -x -C .agent/tmp/g && rm -rf .agent/tmp/g/src/',
    'd=$(mktemp -d) && tar --extract --file=a.tar --directory="$d" && rm -rf "$d/a/"*',
    'pwsh -c "Expand-Archive a.zip -DestinationPath .agent/tmp/e" && rm -rf .agent/tmp/e/x/*',
    'pwsh -c "Expand-Archive a.zip .agent/tmp/e" && rm -rf .agent/tmp/e/x/',
    'cd .agent/tmp/j && jar xf ../a.jar && rm -rf .agent/tmp/x',
    'cpio -idm < a.cpio && rm -rf .agent/tmp/c',
    'cmd //c "tar -xf a.zip -C x" && rm -rf .agent/tmp/build',
  ])('распаковка и шаг сквозь неё в этой же команде — человеку: %s', (command) => {
    expect(decide(command)).toBe('human');
  });

  it('PowerShell `Expand-Archive` и шаг сквозь распакованное — человеку', () => {
    expect(
      kind(
        'pwsh -c "Expand-Archive a.zip -DestinationPath .agent/tmp/e; Remove-Item .agent/tmp/e/x/* -Recurse"',
      ),
    ).toBe('danger');
  });

  it.each([
    'd=$(mktemp -d) && tar -xf evil.tar -C "$d" && rm -rf "$d"',
    'd=$(mktemp -d) && tar -xf evil.tar -C "$d" && ls "$d" && rm -rf "$d/l"',
    'unzip -q a.zip -d .agent/tmp/u && rm -rf .agent/tmp/u',
    'tar -tzf a.tgz && rm -rf .agent/tmp/x/y/',
    'tar -xzf a.tgz -C .agent/tmp/x && echo hi > .agent/tmp/log.txt',
    'tar -czf .agent/tmp/out.tgz src && rm -rf .agent/tmp/old/',
    'cmd //c "tar -tf a.zip" && rm -rf .agent/tmp/build',
  ])('распаковка без шага сквозь неё — сама: %s', (command) => {
    expect(decide(command)).toBe('auto');
  });

  it('распаковано прошлой командой: ссылку на диске сверяет живая проверка', () => {
    const into = join(pad, 'unpacked');
    mkdirSync(into, { recursive: true });
    bash(`tar -xf evil.tar -C "${slash(into)}"`, base, 'winsymlinks:sys');
    expect(kind(`rm -rf "${slash(into)}/l/"*`)).toBe('danger');
    expect(kind(`echo x > "${slash(into)}/l/f.txt"`)).toBe('danger');
    // Сама ссылка без захода внутрь — уборка.
    expect(kind(`rm -rf "${slash(into)}/l"`)).toBe('routine');
  });

  it.runIf(process.platform === 'win32')(
    'без `MSYS=winsymlinks` tar кладёт копию каталога: удаление в ней — уборка, цель цела',
    () => {
      const plain = join(pad, 'plain');
      mkdirSync(plain);
      bash(`tar -xf evil.tar -C "${slash(plain)}"`, base);
      expect(readdirSync(join(plain, 'l'))).toEqual(['data.txt']);
      const command = `rm -rf "${slash(plain)}/l/"*`;
      expect(kind(command)).toBe('routine');
      bash(command, base);
      expect(existsSync(join(victim, 'data.txt'))).toBe(true);
    },
  );

  // Ссылку кладёт прошлая команда (`ln -s` Git Bash); судится следующая.
  it.runIf(process.platform === 'win32').each([
    ['winsymlinks:sys', 'PAD/s1', 'rm -rf "PAD/s1/l/"*'],
    ['winsymlinks:lnk', 'PAD/s2', 'rm -rf "PAD/s2/l/"*'],
    ['winsymlinks:sys', 'PAD/s3', 'rm -rf "PAD/s3/l/deep/x/"'],
    ['winsymlinks:lnk', 'PAD/s4', 'echo x > "PAD/s4/l/f.txt"'],
    ['winsymlinks:sys', '.agent/tmp/m', 'rm -rf .agent/tmp/m/l/*'],
    ['winsymlinks:lnk', '.agent/tmp/n', 'echo x > .agent/tmp/n/l/sub/f.txt'],
  ])('ссылка MSYS, которой не видит realpath (%s в %s), — человеку: %s', (msys, dir, command) => {
    const at = join(dir.startsWith('PAD') ? pad : copy, dir.replace(/^PAD\/?/, ''));
    mkdirSync(at, { recursive: true });
    bash(`ln -s "${slash(victim)}" "${slash(join(at, 'l'))}"`, base, msys);
    expect(kind(command.replace('PAD', slash(pad)))).toBe('danger');
  });
});
