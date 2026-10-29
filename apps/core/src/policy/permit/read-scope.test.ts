import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { SDK_PERMIT_CODEC } from '../../adapters/sdk-stream/permit-codec.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { answerPermitCall } from '../../conductor/model-tools/permit-call.ts';
import { openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { createPendingPermits } from './pending.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext, ReadScope } from './permit.types.ts';

/**
 * Область чтения сеанса (06 §Session permissions, решение владельца 28.10, F-87): вне копии —
 * отказ `outside-copy`; разрешены копия, кеши зависимостей и инструменты, временный каталог
 * сеанса, каталоги слоя CLI (без файлов учётных данных) и список человека. Пути платформы и
 * учётные данные закрыты и внутри разрешённого каталога.
 */

const isWin = process.platform === 'win32';
const base = tempDir('read-scope-');
const copy = join(base, 'copy');
const outside = join(base, 'outside');
const toolchain = join(base, 'toolchain');
const layer = join(base, 'layer');
const credential = join(layer, '.credentials.json');
const human = join(base, 'human');
const coreHome = join(base, 'core-home');
const token = join(coreHome, 'token');
const ownTemp = join(coreHome, 'sessions', 's1', 'tmp');
for (const dir of [join(copy, 'src'), outside, toolchain, join(layer, 'skills'), human, ownTemp]) {
  mkdirSync(dir, { recursive: true });
}
for (const file of [
  join(copy, 'src', 'a.ts'),
  join(outside, 'secret.txt'),
  join(toolchain, 'pkg.js'),
  join(layer, 'skills', 'x.md'),
  credential,
  join(human, 'shared.ts'),
  token,
  join(ownTemp, 'out.txt'),
]) {
  writeFileSync(file, 'x');
}
// Каталог-ссылка в копии наружу (junction на Windows, symlink на POSIX): судья видит цель ссылки.
symlinkSync(outside, join(copy, 'link'), 'junction');
const cleanCopy = join(base, 'clean-copy');
mkdirSync(join(cleanCopy, 'src'), { recursive: true });
writeFileSync(join(cleanCopy, 'src', 'a.ts'), 'x');
symlinkSync(coreHome, join(ownTemp, 'home-link'), 'junction');

const scope: ReadScope = {
  roots: [toolchain, layer],
  human: [human],
  ownTemp,
  credentials: [credential],
};

const ctx = (readScope?: ReadScope, extra: Partial<PermitContext> = {}): PermitContext => ({
  copyRoot: copy,
  ownedPaths: [],
  deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
  platformPaths: [coreHome],
  endpointSources: [],
  grantRequired: [],
  grants: [],
  ...(readScope ? { readScope } : {}),
  ...extra,
});

const read = (target: string, tool = 'Read'): PermissionAsk => ({
  action: 'read',
  target,
  tool,
  display: `${tool} ${target}`,
});

const exec = (command: string): PermissionAsk => ({
  action: 'exec',
  target: command.split(' ')[0] ?? '',
  argv: command.split(' '),
  tool: 'Bash',
  display: command,
});

const systemFile = isWin ? 'C:\\Windows\\win.ini' : '/etc/passwd';

describe('F-87 read scope', () => {
  describe('outside the copy is refused by default', () => {
    it.each([
      ['a system file', systemFile],
      ['a sibling file by absolute path', join(outside, 'secret.txt')],
      ['a sibling file by a relative climb', `../outside/secret.txt`],
      ['a search rooted outside', `${outside}/**/*.txt`],
      ['a search mask that climbs after the wildcard', 'src/**/../../../outside/*'],
      ['a file behind a link inside the copy', join(copy, 'link', 'secret.txt')],
    ])('%s → outside-copy', (_what, target) => {
      expect(decidePermit(read(target), ctx())).toMatchObject({
        allow: false,
        code: 'outside-copy',
        humanPoint: null,
      });
    });
  });

  describe('inside the copy is read', () => {
    it.each([
      ['a relative file', 'src/a.ts', copy],
      ['an absolute file', join(copy, 'src', 'a.ts'), copy],
      // Копия выше держит ссылку наружу (`link`) — поиск по ней отказан (read-scope-links);
      // поиск без пути — в копии без ссылок.
      ['a search without a path (cwd = copy)', '**/*.ts', cleanCopy],
      ['an empty search root (cwd = copy)', '', cleanCopy],
    ])('%s → allowed', (_what, target, copyRoot) => {
      expect(decidePermit(read(target, 'Glob'), ctx(undefined, { copyRoot }))).toMatchObject({
        allow: true,
      });
    });
  });

  it('roots of the platform and the human list are read; their siblings are not', () => {
    const c = ctx(scope);
    expect(decidePermit(read(join(toolchain, 'pkg.js')), c)).toMatchObject({ allow: true });
    expect(decidePermit(read(`${toolchain}/**/*.js`, 'Glob'), c)).toMatchObject({ allow: true });
    expect(decidePermit(read(join(layer, 'skills', 'x.md')), c)).toMatchObject({ allow: true });
    expect(decidePermit(read(join(human, 'shared.ts')), c)).toMatchObject({
      allow: true,
      reason: expect.stringContaining('human'),
    });
    expect(decidePermit(read(join(outside, 'secret.txt')), c)).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });
    expect(decidePermit(read(systemFile), c)).toMatchObject({ code: 'outside-copy' });
  });

  it('a credential file inside an allowed layer dir stays closed, and so does a search over it', () => {
    const c = ctx(scope);
    expect(decidePermit(read(credential), c)).toMatchObject({
      allow: false,
      code: 'credential-path',
    });
    expect(decidePermit(read(layer, 'Grep'), c)).toMatchObject({ code: 'credential-path' });
    expect(decidePermit(read(`${layer}/**`, 'Glob'), c)).toMatchObject({
      code: 'credential-path',
    });
    // Маска, что поднимается после звёздочки: голова — в копии, цель — файл учётных данных.
    const climb = `src/**/../../../${relative(base, credential).replace(/\\/g, '/')}`;
    expect(decidePermit(read(climb, 'Glob'), c)).toMatchObject({ code: 'credential-path' });
    if (isWin) {
      expect(decidePermit(read(credential.toUpperCase()), c)).toMatchObject({
        code: 'credential-path',
      });
    }
  });

  it('the session temp dir is read even inside the core home; the rest of the core home is not', () => {
    const c = ctx(scope);
    expect(decidePermit(read(join(ownTemp, 'out.txt')), c)).toMatchObject({
      allow: true,
      reason: expect.stringContaining('temp'),
    });
    // Поиск по временному каталогу обходит его ссылки: `home-link` ведёт в дом ядра (проход 2).
    expect(decidePermit(read(`${ownTemp}/**`, 'Glob'), c)).toMatchObject({
      code: 'platform-path',
    });
    expect(decidePermit(read(token), c)).toMatchObject({ code: 'platform-path' });
    expect(decidePermit(read(join(coreHome, 'sessions', 's1', 'spec.json')), c)).toMatchObject({
      code: 'platform-path',
    });
    // Ссылка из временного каталога на дом ядра: решает цель ссылки.
    expect(decidePermit(read(join(ownTemp, 'home-link', 'token')), c)).toMatchObject({
      code: 'platform-path',
    });
    // Временный каталог, который сам содержит путь платформы, не открывается.
    const wide = ctx({ ...scope, ownTemp: coreHome });
    expect(decidePermit(read(join(coreHome, 'sessions', 's1', 'spec.json')), wide)).toMatchObject({
      code: 'platform-path',
    });
  });

  it('a platform path inside an allowed root stays closed', () => {
    const c = ctx(scope, { platformPaths: [coreHome, join(toolchain, 'pkg.js')] });
    expect(decidePermit(read(join(toolchain, 'pkg.js')), c)).toMatchObject({
      code: 'platform-path',
    });
  });

  describe('exec: credential words are refused, other outside paths are not judged', () => {
    it('a command naming a credential file → credential-path', () => {
      expect(decidePermit(exec(`cat ${credential.replace(/\\/g, '/')}`), ctx(scope))).toMatchObject(
        {
          allow: false,
          code: 'credential-path',
        },
      );
    });

    it('a command naming a file outside the read scope → allowed (the program reads itself; 06 boundary)', () => {
      const target = relative(copy, join(outside, 'secret.txt')).replace(/\\/g, '/');
      expect(decidePermit(exec(`cat ${target}`), ctx(scope))).toMatchObject({ allow: true });
    });
  });

  describe.runIf(isWin)('unfoldable entries', () => {
    it('an unfoldable human entry grants nothing; the other entries still do', () => {
      const c = ctx({ ...scope, human: ['\\\\fileserver\\share', human] });
      expect(decidePermit(read(join(human, 'shared.ts')), c)).toMatchObject({ allow: true });
      expect(decidePermit(read(join(outside, 'secret.txt')), c)).toMatchObject({
        code: 'outside-copy',
      });
    });

    it('an unfoldable credential file closes the path road', () => {
      const c = ctx({ ...scope, credentials: ['\\\\fileserver\\share\\creds.json'] });
      expect(decidePermit(read(join(toolchain, 'pkg.js')), c)).toMatchObject({
        allow: false,
        code: 'platform-path',
      });
    });
  });

  it('the decision is journaled with its refusal code on the agentdeck-permit road', async () => {
    const { task } = await openFresh();
    const seeded = seedSession(task, { stepKind: 'work' });
    const bound = bindingOf(task, seeded.sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const gate = createPendingPermits({ selfToolNames: ['mcp__agentdeck-permit__approve'] });
    gate.observe(seeded.sessionId, {
      type: 'tool.requested',
      toolUseId: 'toolu_r1',
      name: 'Read',
      input: {},
    } as never);
    const answer = await answerPermitCall(
      task,
      bound.binding,
      { tool_name: 'Read', input: { file_path: systemFile }, tool_use_id: 'toolu_r1' },
      {
        gate,
        codec: SDK_PERMIT_CODEC,
        mapPermission: mapClaudePermission,
        context: ctx(scope),
        settleMs: 80,
      },
    );
    expect(answer).toMatchObject({ reply: { behavior: 'deny' } });
    const decision = readJournalLines(task.dir, task.taskId).lines.find(
      (l) => l.kind === 'decision',
    );
    expect(decision?.data).toMatchObject({
      class: 'permit',
      output: { allow: false, code: 'outside-copy', action: 'read', target: systemFile },
    });
    task.close();
  });
});
