import { describe, expect, it } from 'vitest';
import { patternCovers, resolveAllowedRoutes } from './resolve.ts';
import type { AllowedRoute, AllowedSetInput } from './resolve.types.ts';

/**
 * P118 таблицей: разрешённый набор — уровень 2 + вход CLI; уровни 3–5 только сужают, тройка вне
 * набора отвергается с именем; обязательный контур сводит к своему шлюзу, шлюз лежит — отказ,
 * облако вендора не берётся.
 */

const key = (adapter: string, pattern = '*'): AllowedRoute => ({
  adapter,
  route: { kind: 'api-key', id: `api-key:${adapter}` },
  modelPattern: pattern,
});
const login = (adapter: string): AllowedRoute => ({
  adapter,
  route: { kind: 'cli-login', id: `cli-login:${adapter}` },
  modelPattern: '*',
});
const local: AllowedRoute = {
  adapter: 'qwen',
  route: { kind: 'local', id: 'local:own' },
  modelPattern: '*',
};

const base = (over: Partial<AllowedSetInput> = {}): AllowedSetInput => ({
  launch: [key('claude')],
  cliLoginOf: (adapter) => (adapter === 'cursor' ? undefined : login(adapter)),
  narrowings: [],
  ...over,
});

const ids = (result: ReturnType<typeof resolveAllowedRoutes>): string[] =>
  result.kind === 'set'
    ? result.allowedRoutes.map((r) => `${r.adapter}/${r.route.id}/${r.modelPattern}`)
    : [`refused:${result.code}`];

describe('policy/resolve allowed set (P118)', () => {
  it('default = launch choice + cli-login of that CLI, source level 2', () => {
    const result = resolveAllowedRoutes(base());
    expect(ids(result)).toEqual(['claude/api-key:claude/*', 'claude/cli-login:claude/*']);
    expect(result.kind === 'set' && result.sourceLevel).toBe(2);
  });

  it('a CLI without a cli-login route gets only the launch choice', () => {
    expect(ids(resolveAllowedRoutes(base({ launch: [key('cursor')] })))).toEqual([
      'cursor/api-key:cursor/*',
    ]);
  });

  it.each([3, 4, 5] as const)(
    'level %i adding a route → rejected + named, set unchanged',
    (level) => {
      const result = resolveAllowedRoutes(
        base({
          narrowings: [
            {
              level,
              source: 'r1: .agentdeck/scenario.json',
              routes: [key('claude'), login('claude'), local],
            },
          ],
        }),
      );
      expect(ids(result)).toEqual(['claude/api-key:claude/*', 'claude/cli-login:claude/*']);
      expect(result.rejected).toEqual([
        expect.objectContaining({
          level,
          path: 'routes.qwen/local:own/*',
          reason: expect.stringContaining('outside the allowed set'),
        }),
      ]);
    },
  );

  it('narrowing applied: model pattern narrowed, unlisted route dropped, source = that level', () => {
    const result = resolveAllowedRoutes(
      base({
        narrowings: [{ level: 4, source: 'project', routes: [key('claude', 'claude-sonnet*')] }],
      }),
    );
    expect(ids(result)).toEqual(['claude/api-key:claude/claude-sonnet*']);
    expect(result.kind === 'set' && result.sourceLevel).toBe(4);
    expect(result.rejected).toEqual([]);
  });

  it('a wider pattern from a lower level is a widening, rejected', () => {
    const result = resolveAllowedRoutes(
      base({
        launch: [key('claude', 'claude-sonnet*')],
        narrowings: [{ level: 5, source: 'user layer', routes: [key('claude', 'claude-*')] }],
      }),
    );
    expect(result.rejected.map((e) => e.path)).toEqual(['routes.claude/api-key:claude/claude-*']);
    expect(ids(result)).toEqual(['refused:not_allowed']);
  });

  it('«local only» by kinds narrows; narrowing to nothing → refused not_allowed, named', () => {
    const mixed = resolveAllowedRoutes(
      base({
        launch: [key('qwen'), local],
        narrowings: [{ level: 4, source: 'project', kinds: ['local'] }],
      }),
    );
    expect(ids(mixed)).toEqual(['qwen/local:own/*']);
    const empty = resolveAllowedRoutes(
      base({ narrowings: [{ level: 3, source: 'scenario', kinds: ['local'] }] }),
    );
    expect(empty).toMatchObject({
      kind: 'refused',
      code: 'not_allowed',
      reasons: ['scenario: narrowed the allowed set to nothing'],
    });
  });

  it('contour required narrows every triple to gateway:<id>, source level 1', () => {
    const result = resolveAllowedRoutes(
      base({ contour: { contourId: 'corp', mode: 'required', gateway: 'up' } }),
    );
    expect(ids(result)).toEqual(['claude/gateway:corp/*']);
    expect(result.kind === 'set' && result.sourceLevel).toBe(1);
  });

  it('contour required + gateway down → refused route_unavailable, never the vendor cloud', () => {
    const result = resolveAllowedRoutes(
      base({ contour: { contourId: 'corp', mode: 'required', gateway: 'down' } }),
    );
    expect(result).toMatchObject({ kind: 'refused', code: 'route_unavailable' });
    expect(result.kind === 'refused' && result.reasons[0]).toMatch(/vendor cloud is never taken/);
  });

  it('contour required + gateway unknown → still the gateway only (waits, P77), never the cloud', () => {
    expect(
      ids(
        resolveAllowedRoutes(
          base({ contour: { contourId: 'corp', mode: 'required', gateway: 'unknown' } }),
        ),
      ),
    ).toEqual(['claude/gateway:corp/*']);
  });

  it('contour best-effort changes nothing', () => {
    expect(
      ids(
        resolveAllowedRoutes(
          base({ contour: { contourId: 'corp', mode: 'best-effort', gateway: 'down' } }),
        ),
      ),
    ).toEqual(['claude/api-key:claude/*', 'claude/cli-login:claude/*']);
  });

  it('required contour + project «local only» → refused, not a silent local run', () => {
    const result = resolveAllowedRoutes(
      base({
        launch: [local],
        contour: { contourId: 'corp', mode: 'required', gateway: 'up' },
        narrowings: [{ level: 4, source: 'project', kinds: ['local'] }],
      }),
    );
    expect(result).toMatchObject({ kind: 'refused', code: 'not_allowed' });
  });

  it('no launch choice → refused', () => {
    expect(ids(resolveAllowedRoutes(base({ launch: [] })))).toEqual(['refused:not_allowed']);
  });

  it('pattern cover: star covers all, prefix covers longer prefix, never the reverse', () => {
    expect(patternCovers('*', 'x')).toBe(true);
    expect(patternCovers('claude-*', 'claude-sonnet*')).toBe(true);
    expect(patternCovers('claude-sonnet*', 'claude-*')).toBe(false);
    expect(patternCovers('a*', '*')).toBe(false);
    expect(patternCovers('gpt-4o', 'gpt-4o')).toBe(true);
  });
});
