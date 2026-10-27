import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupCommandVerdict } from './group-command.ts';

/**
 * D-7 (25.10): группа завела точку соединения в своей рабочей папке на
 * `node_modules` своей же копии (`cmd //c mklink /J "$(cygpath -w $W/…)"
 * "$(cygpath -w …)"`) и прогнала проверку — карточка человеку. Путь ссылки в
 * строке `cmd` не прослеживался: «ссылка где угодно», и всё после неё судилось
 * как путь через чужое. Обе стороны названы — ссылка в копии на каталог копии
 * своя; ссылка или цель вне копии, путь не узнать — человеку, как прежде.
 */
describe('cmd /c mklink /J|/D — ссылка каталога своей копии (D-7)', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mklink-')));
  const copy = join(base, 'shop-worktrees', 'fix-a');
  const scope = { worktree: copy, cwd: copy, branch: 'fix/a', ignored: [] };
  const kind = (command: string, extra: Partial<typeof scope> = {}): string =>
    groupCommandVerdict(command, { ...scope, ...extra }).kind;
  const slash = (path: string): string => path.replace(/\\/g, '/');

  beforeAll(() => {
    mkdirSync(join(copy, '.agent', 'tmp', 'vf-wt', 'inst-docs-ui'), { recursive: true });
    mkdirSync(join(copy, 'inst-docs-ui', 'node_modules'), { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** Команда карточки D-7 без хвоста из `grep`: ссылка, затем проверка из рабочей папки. */
  const D7 = [
    'W=.agent/tmp/vf-wt',
    'git -C $W diff --stat | tail -1',
    'cmd //c mklink /J "$(cygpath -w $W/inst-docs-ui/node_modules)" "$(cygpath -w inst-docs-ui/node_modules)" >/dev/null',
    'node $W/inst-docs-ui/scripts/check_content.mjs > .agent/tmp/vf-p0.log 2>&1',
    'echo "p0 rc=$?"',
    'tail -2 .agent/tmp/vf-p0.log',
    'grep -n "Form start" $W/inst-docs-ui/content/en/agents/builder.mdx | head -5',
  ].join('; ');

  it('D-7: ссылка в рабочей папке копии на `node_modules` копии — своя работа', () => {
    // Запуск сценария (`node …`) и `cygpath` правила чата судят как прежде — «other», не человеку.
    expect(kind(D7)).toBe('other');
  });

  it('словами, абсолютными путями и с `/D` — тоже своя', () => {
    const link = slash(join(copy, '.agent', 'tmp', 'l'));
    const target = slash(join(copy, 'inst-docs-ui', 'node_modules'));
    expect(kind(`cmd //c mklink //J "${link}" "${target}"; echo ok`)).toBe('routine');
    expect(kind(`cmd /c mklink /D .agent/tmp/l inst-docs-ui/node_modules; echo ok`)).toBe(
      'routine',
    );
    expect(kind(`cmd /c mklink /D .agent/tmp/l inst-docs-ui/node_modules; node x.mjs`)).toBe(
      'other',
    );
  });

  it('цель или ссылка вне копии — человеку', () => {
    expect(kind('cmd //c mklink /J .agent/tmp/l "$(cygpath -w /c/work)"')).toBe('danger');
    expect(kind('cmd //c mklink /J .agent/tmp/l ../fix-b/node_modules')).toBe('danger');
    expect(kind('cmd //c mklink /J ../l inst-docs-ui/node_modules')).toBe('danger');
    expect(kind('cmd /c mklink /J C:/elsewhere/l inst-docs-ui/node_modules')).toBe('danger');
  });

  it('путь не проследить или вид не тот — человеку, как до D-7', () => {
    for (const command of [
      'cmd //c mklink /J "$L" inst-docs-ui/node_modules; node x.mjs',
      'cmd //c mklink /J .agent/tmp/l "$(realpath inst-docs-ui/node_modules)"; node x.mjs',
      'cmd //c mklink /J .agent/tmp/l "inst-docs-ui/node_modules & del x"; node x.mjs',
      'cmd //c mklink /H .agent/tmp/l inst-docs-ui/x.txt; node x.mjs',
      'cmd mklink /J .agent/tmp/l inst-docs-ui/node_modules; node x.mjs',
      // Без `/c` строка не исполняется как команда; третий путь — не тот вид `mklink`.
      'cmd //q mklink /J .agent/tmp/l inst-docs-ui/node_modules; node x.mjs',
      'cmd //c mklink /J .agent/tmp/l inst-docs-ui/node_modules extra; node x.mjs',
    ]) {
      expect(kind(command), command).toBe('danger');
    }
  });

  it('угаданный корень оболочки и относительные пути — человеку', () => {
    const guessed = { worktree: copy, branch: 'fix/a', ignored: [] };
    expect(
      groupCommandVerdict(
        'cmd //c mklink /J .agent/tmp/l inst-docs-ui/node_modules; node x.mjs',
        guessed,
      ).kind,
    ).toBe('danger');
  });

  /**
   * D-12 (26.10): та же ссылка, но строка `cmd` в кавычках одним словом — слова
   * те же, а разбор её не видел, и проверка из рабочей папки ушла человеку.
   */
  const D12 = String.raw`cmd //c "mklink /J .agent\\tmp\\vf-wt\\inst-docs-ui\\node_modules inst-docs-ui\\node_modules" >/dev/null 2>&1; ls .agent/tmp/vf-wt/inst-docs-ui/node_modules/yaml >/dev/null 2>&1 && echo linked; node .agent/tmp/vf-wt/inst-docs-ui/scripts/check_content.mjs > .agent/tmp/vf-base.log 2>&1; echo "exit $?"`;

  it('D-12: строка `cmd` в кавычках — та же своя ссылка', () => {
    expect(kind(D12)).not.toBe('danger');
    expect(kind('cmd //c "mklink /J .agent/tmp/l inst-docs-ui/node_modules"; node x.mjs')).not.toBe(
      'danger',
    );
  });

  it('строка `cmd` в кавычках со сверхом или чужим путём — человеку', () => {
    for (const command of [
      'cmd //c "mklink /J .agent/tmp/l inst-docs-ui/node_modules & del x"; node x.mjs',
      'cmd //c "mklink /J .agent/tmp/l inst-docs-ui/node_modules | more"; node x.mjs',
      'cmd //c "mklink /J ../l inst-docs-ui/node_modules"; node x.mjs',
      'cmd //c "mklink /J .agent/tmp/l %USERPROFILE%"; node x.mjs',
      'cmd //c "mklink /J .agent/tmp/l $L"; node x.mjs',
      // `!ИМЯ!` и скобки — подстановка и группа `cmd`, хоть слово и без пробелов.
      'cmd //c "mklink /J .agent/tmp/l inst-docs-ui/!P!"; node x.mjs',
      'cmd //c "mklink /J .agent/tmp/l (inst-docs-ui/node_modules)"; node x.mjs',
      'cmd //c "mklink /H .agent/tmp/l inst-docs-ui/x.txt"; node x.mjs',
      'cmd //c "mklink /J .agent/tmp/l inst-docs-ui/node_modules extra"; node x.mjs',
      'cmd //q "mklink /J .agent/tmp/l inst-docs-ui/node_modules"; node x.mjs',
    ]) {
      expect(kind(command), command).toBe('danger');
    }
  });

  it('удаление и `git clean -x` через такую ссылку — не уборка своего (D-5)', () => {
    const made = 'cmd //c mklink /J .agent/tmp/l inst-docs-ui/node_modules';
    expect(kind(`${made}; rm -rf .agent/tmp/l/*`)).toBe('danger');
    expect(kind(`${made}; rm -rf .agent/tmp/l/x`)).toBe('danger');
    expect(kind(`${made}; git -C .agent/tmp clean -fdx`)).toBe('danger');
  });
});
