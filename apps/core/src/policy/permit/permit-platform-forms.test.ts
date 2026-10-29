import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * H7 (core-s2): цель судья складывает в `C:\…` (F-126), а пути из контекста — дом ядра, токены,
 * корень копии, `deny.editPaths`, источники адресов — сравнивались как написаны. Дом ядра,
 * заданный `\\localhost\C$\…`, не совпадал с `C:\…`-написанием токена: чтение разрешалось
 * (проба v5 unc-home). Здесь каждое написание с обеих сторон — отказ `platform-path`, а запись
 * контекста, которую сложить нельзя, закрывает судью, а не выпадает из списка.
 */

const isWin = process.platform === 'win32';

const ask = (action: 'read' | 'edit', target: string): PermissionAsk => ({
  action,
  target,
  tool: action === 'read' ? 'Read' : 'Write',
  display: `${action} ${target}`,
});

const typed = (argv: string[]): PermissionAsk => ({
  action: 'exec',
  target: argv[0] ?? '',
  argv,
  tool: 'Bash',
  display: '',
});

const shell = (command: string): PermissionAsk =>
  mapClaudePermission({ tool: 'Bash', input: { command } });

const base = (platformPaths: string[], copyRoot = process.cwd()): PermitContext => ({
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
  platformPaths,
  endpointSources: [],
  grantRequired: [],
  grants: [],
});

const refused = { allow: false, code: 'platform-path' };

describe.runIf(isWin)('H7 platform paths in another Windows spelling', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'permit-h7-')));
  const home = join(root, 'agentdeck-core-home-long');
  mkdirSync(home);
  const token = join(home, 'token');
  writeFileSync(token, 'FAKE-VENDOR-TOKEN');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const drive = home.slice(0, 1);
  const tail = home.slice(2);
  // Тело пропущенного набора vitest всё равно исполняет при сборе — без `cmd` (Linux) не звать.
  const short = isWin
    ? spawnSync('cmd', [`/d /c for %I in ("${home}") do @echo %~sI`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      }).stdout.trim()
    : home;
  // Тома без имён 8.3 бывают: тогда короткое написание совпадает с длинным.
  const hasShort = short.toLowerCase() !== home.toLowerCase() && /~\d/.test(short);

  const spellings: [string, string][] = [
    ['UNC localhost admin share', `\\\\localhost\\${drive}$${tail}`],
    ['UNC 127.0.0.1, lower-case share', `\\\\127.0.0.1\\${drive.toLowerCase()}$${tail}`],
    ['long prefix', `\\\\?\\${home}`],
    ['device prefix', `\\\\.\\${home}`],
    ['long UNC prefix', `\\\\?\\UNC\\localhost\\${drive}$${tail}`],
    ['forward-slash UNC', `//localhost/${drive}$${tail.replace(/\\/g, '/')}`],
    ['different case', home.toUpperCase()],
    ['trailing dot', `${home}.`],
    ...(hasShort ? ([['8.3 short form', short]] as [string, string][]) : []),
  ];

  describe('platformPaths spelled otherwise, the token by its plain C:\\ spelling', () => {
    it.each(spellings)('%s → read, edit, exec, ancestor search refused', (_form, spelled) => {
      const ctx = base([spelled]);
      expect(decidePermit(ask('read', token), ctx)).toMatchObject(refused);
      expect(decidePermit(ask('edit', token), ctx)).toMatchObject(refused);
      expect(decidePermit(typed(['cat', token]), ctx, 'work')).toMatchObject(refused);
      const slashed = token.replace(/\\/g, '/');
      expect(decidePermit(shell(`cat ${slashed}`), ctx, 'work')).toMatchObject(refused);
      expect(decidePermit(ask('read', join(root, '**', 'token')), ctx)).toMatchObject(refused);
      expect(decidePermit(typed(['rg', 'secret', root]), ctx, 'work')).toMatchObject(refused);
    });

    it('8.3 form exists on this volume or the case is skipped knowingly', () => {
      // Без короткого имени строка 8.3 выше не прогоняется: это видно здесь, а не молчит.
      if (!hasShort) return;
      expect(short).toMatch(/~\d/);
    });
  });

  describe('platformPaths plain, the token in another spelling', () => {
    const ctx = base([home]);
    const targets: [string, string][] = spellings.map(([form, spelled]) => [
      form,
      `${spelled}\\token`,
    ]);
    it.each(targets)('%s → read, edit, exec refused', (_form, target) => {
      expect(decidePermit(ask('read', target), ctx)).toMatchObject(refused);
      expect(decidePermit(ask('edit', target), ctx)).toMatchObject(refused);
      expect(decidePermit(typed(['cat', target]), ctx, 'work')).toMatchObject(refused);
    });

    it('shell text with a forward-slash admin share → refused', () => {
      const unc = `//localhost/${drive}$${tail.replace(/\\/g, '/')}/token`;
      expect(decidePermit(shell(`cat ${unc}`), ctx, 'work')).toMatchObject(refused);
    });

    it('a share of a foreign host in a command → refused: it may be this disk', () => {
      expect(decidePermit(typed(['type', '\\\\fileserver\\share\\x']), ctx, 'work')).toMatchObject(
        refused,
      );
      expect(
        decidePermit(typed(['cat', '\\\\?\\GLOBALROOT\\Device\\X\\t']), ctx, 'work'),
      ).toMatchObject(refused);
    });

    it('words that only look like a share prefix stay allowed', () => {
      expect(decidePermit(shell('grep -rn "// TODO" src'), ctx, 'work')).toMatchObject({
        allow: true,
      });
      expect(decidePermit(typed(['rg', '\\\\bfoo', 'src']), ctx, 'work')).toMatchObject({
        allow: true,
      });
      expect(decidePermit(typed(['grep', '-r', '//', 'src']), ctx, 'work')).toMatchObject({
        allow: true,
      });
    });

    it('cd into the share spelling, then a relative path → refused', () => {
      const cdUnc = `\\\\localhost\\${drive}$${tail}`;
      expect(decidePermit(typed(['cat', cdUnc]), ctx, 'work')).toMatchObject(refused);
      const viaCd = shell(`cd //localhost/${drive}$${tail.replace(/\\/g, '/')} && cat token`);
      expect(decidePermit(viaCd, ctx, 'work')).toMatchObject(refused);
    });
  });

  describe('copy root in a share spelling', () => {
    const cwd = process.cwd();
    const copyUnc = `\\\\localhost\\${cwd.slice(0, 1)}$${cwd.slice(2)}`;
    const ctx = base([home], copyUnc);

    it('a relative read that climbs to the token → refused', () => {
      expect(decidePermit(ask('read', relative(cwd, token)), ctx)).toMatchObject(refused);
    });

    it('an edit inside the copy by its plain spelling is an edit inside the copy', () => {
      expect(decidePermit(ask('edit', join(cwd, 'src', 'x.ts')), ctx)).toMatchObject({
        allow: true,
      });
      expect(decidePermit(ask('edit', 'src/x.ts'), ctx)).toMatchObject({ allow: true });
    });
  });

  describe('a context path that cannot be folded closes the judge', () => {
    const foreign = '\\\\fileserver\\share\\agentdeck';

    it('platformPaths entry → read, edit, exec refused; mcp still judged', () => {
      const ctx = base([foreign]);
      expect(decidePermit(ask('read', 'src/index.ts'), ctx)).toMatchObject(refused);
      expect(decidePermit(ask('edit', 'src/index.ts'), ctx)).toMatchObject(refused);
      expect(decidePermit(typed(['ls']), ctx, 'work')).toMatchObject(refused);
      expect(
        decidePermit({ action: 'mcp', target: 'x__y', tool: 'x__y', display: 'x__y' }, ctx),
      ).toMatchObject({ allow: true });
    });

    it('copy root → read, edit, exec refused', () => {
      const ctx = base([home], foreign);
      expect(decidePermit(ask('read', 'src/index.ts'), ctx)).toMatchObject(refused);
      expect(decidePermit(ask('edit', 'src/index.ts'), ctx)).toMatchObject(refused);
      expect(decidePermit(typed(['ls']), ctx, 'work')).toMatchObject(refused);
    });

    it('deny.editPaths entry → edit refused as denied-path, read allowed', () => {
      const ctx = { ...base([home]), deny: { ...base([home]).deny, editPaths: [foreign] } };
      expect(decidePermit(ask('edit', 'src/index.ts'), ctx)).toMatchObject({
        allow: false,
        code: 'denied-path',
      });
      expect(decidePermit(ask('read', 'src/index.ts'), ctx)).toMatchObject({ allow: true });
    });

    it('endpointSources entry → read refused at human point 3', () => {
      const ctx = { ...base([home]), endpointSources: [foreign] };
      expect(decidePermit(ask('read', 'src/index.ts'), ctx)).toMatchObject({
        allow: false,
        code: 'endpoint-source',
        humanPoint: 3,
      });
    });
  });

  describe('deny.editPaths and endpointSources in a share spelling', () => {
    const cwd = process.cwd();
    const share = (p: string) => `\\\\localhost\\${p.slice(0, 1)}$${p.slice(2)}`;

    it('editPaths as an admin share → edit by the plain spelling refused', () => {
      const ctx = {
        ...base([home]),
        deny: { ...base([home]).deny, editPaths: [share(join(cwd, '.qwen'))] },
      };
      expect(decidePermit(ask('edit', '.qwen/settings.json'), ctx)).toMatchObject({
        allow: false,
        code: 'denied-path',
      });
    });

    it('endpointSources as an admin share → read by the plain spelling at point 3', () => {
      const ctx = { ...base([home]), endpointSources: [share(join(cwd, '.env'))] };
      expect(decidePermit(ask('read', '.env'), ctx)).toMatchObject({
        allow: false,
        code: 'endpoint-source',
      });
    });
  });
});
