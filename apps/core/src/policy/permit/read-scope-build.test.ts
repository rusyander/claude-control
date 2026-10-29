import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { decidePermit } from './permit.ts';
import { buildReadScope } from './read-scope-build.ts';
import type { PermitContext, ReadScopeInput } from './permit.types.ts';

/**
 * Сборщик области чтения (F-87): факты владельцев → `ReadScope`; запись человека от корня копии;
 * несводимое или относительное разрешение не принимается и называется; запрет не выбрасывается.
 */

const isWin = process.platform === 'win32';
const base = tempDir('read-scope-build-');
const copy = join(base, 'copy');

const input = (over: Partial<ReadScopeInput> = {}): ReadScopeInput => ({
  copyRoot: copy,
  sessionTemp: join(base, 'tmp'),
  layer: { dirs: [join(base, 'layer')], credentials: [join(base, 'layer', 'creds.json')] },
  toolchainRoots: [join(base, 'cache')],
  humanAllow: [],
  ...over,
});

const ctx = (over: Partial<ReadScopeInput>): PermitContext => ({
  copyRoot: copy,
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
  readScope: buildReadScope(input(over)).scope,
});

describe('F-87 buildReadScope', () => {
  it('collects platform roots and layer dirs, the session temp dir and the credentials', () => {
    const built = buildReadScope(input());
    expect(built.refused).toEqual([]);
    expect(built.scope).toEqual({
      roots: [join(base, 'cache'), join(base, 'layer')],
      human: [],
      ownTemp: join(base, 'tmp'),
      credentials: [join(base, 'layer', 'creds.json')],
    });
  });

  it('a relative human entry is taken from the copy root, not from the core cwd', () => {
    const built = buildReadScope(input({ humanAllow: ['../shared-lib'] }));
    expect(built.scope.human).toEqual([join(base, 'shared-lib')]);
    expect(
      decidePermit(
        { action: 'read', target: join(base, 'shared-lib', 'a.ts'), tool: 'Read', display: '' },
        ctx({ humanAllow: ['../shared-lib'] }),
      ),
    ).toMatchObject({ allow: true });
  });

  it('an empty or relative platform/adapter entry is refused and named, never resolved', () => {
    const built = buildReadScope(
      input({ toolchainRoots: ['', 'relative/cache'], humanAllow: [' '] }),
    );
    expect(built.scope.roots).toEqual([join(base, 'layer')]);
    expect(built.scope.human).toEqual([]);
    expect(built.refused.map((r) => r.entry)).toEqual(['', 'relative/cache', ' ']);
  });

  it.runIf(isWin)(
    'an unfoldable human entry is refused and named; the read stays outside-copy',
    () => {
      const built = buildReadScope(input({ humanAllow: ['\\\\fileserver\\share'] }));
      expect(built.scope.human).toEqual([]);
      expect(built.refused).toEqual([
        { entry: '\\\\fileserver\\share', reason: expect.stringContaining('not comparable') },
      ]);
    },
  );

  it('a relative credential entry is kept and closes the path road instead of being dropped', () => {
    const built = buildReadScope(
      input({ layer: { dirs: [join(base, 'layer')], credentials: ['creds.json'] } }),
    );
    expect(built.scope.credentials).toEqual(['creds.json']);
    const decision = decidePermit(
      { action: 'read', target: 'src/a.ts', tool: 'Read', display: '' },
      ctx({ layer: { dirs: [], credentials: ['creds.json'] } }),
    );
    expect(decision).toMatchObject({ allow: false, code: 'platform-path' });
  });
});
