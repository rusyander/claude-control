import { afterEach, describe, expect, it } from 'vitest';
import { readJournalLines } from '../../journal/read-lines.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { resolveAllowedRoutes } from '../../policy/resolve/resolve.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import {
  API_KEY,
  envelope,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
  QWEN,
} from '../scenario/__fixtures__/scenario-harness.ts';
import type { CommandEnv, SetRoutePorts } from './commands.types.ts';
import { decideSetRoute } from './set-route.ts';

/**
 * P118, уровень 2: расширить разрешённый набор может только живая команда человека `set-route`;
 * слои 3–5 тем же набором троек расширить не могут (`policy/resolve`). Обязательный контур не
 * обходится и командой. Прошедший суд набор ложится строкой `routes.set`, и свёртка читает его
 * поверх набора `task.created`.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const KINDS: Record<string, 'cli-login' | 'api-key' | 'local' | 'gateway'> = {
  [LOGIN.route.id]: 'cli-login',
  [API_KEY.route.id]: 'api-key',
  [QWEN.route.id]: 'local',
  'gateway:corp': 'gateway',
};
const ports = (over: Partial<SetRoutePorts> = {}): SetRoutePorts => ({
  routeOf: (id) => (KINDS[id] ? { kind: KINDS[id] } : undefined),
  ...over,
});
const env = (p?: SetRoutePorts): CommandEnv => ({ ...commandEnv(), routes: () => p });
const GW = {
  adapter: 'claude',
  route: { kind: 'gateway' as const, id: 'gateway:corp' },
  modelPattern: '*',
};

describe('set-route (P118 level 2)', () => {
  it('widening by the command is accepted and NAMED; the same widening by a level-4 layer is rejected', () => {
    const decision = decideSetRoute([LOGIN], [LOGIN, QWEN], ports());
    expect(decision).toMatchObject({ ok: true, widened: [QWEN], narrowed: [] });
    const layer = resolveAllowedRoutes({
      launch: [LOGIN],
      cliLoginOf: () => undefined,
      narrowings: [{ level: 4, source: 'project', routes: [LOGIN, QWEN] }],
    });
    expect(layer.kind === 'set' && layer.allowedRoutes).toEqual([LOGIN]);
    expect(layer.rejected.map((e) => e.level)).toEqual([4]);
  });

  it('narrowing is named too; an unregistered or mis-kinded route → unknown-route with every reason', () => {
    expect(decideSetRoute([LOGIN, API_KEY], [API_KEY], ports())).toMatchObject({
      ok: true,
      widened: [],
      narrowed: [LOGIN],
    });
    const bad = decideSetRoute(
      [LOGIN],
      [
        { ...LOGIN, route: { kind: 'cli-login', id: 'ghost' } },
        { ...QWEN, route: { kind: 'api-key', id: QWEN.route.id } },
      ],
      ports(),
    );
    expect(bad).toMatchObject({ ok: false, code: 'unknown-route' });
    expect(bad.ok === false && bad.reasons).toHaveLength(2);
  });

  it('required contour: only its gateway passes; gateway down → route_unavailable', () => {
    const required = ports({ contour: { contourId: 'corp', mode: 'required', gateway: 'up' } });
    expect(decideSetRoute([GW], [GW, API_KEY], required)).toMatchObject({
      ok: false,
      code: 'outside-allowed-set',
      reasons: [expect.stringContaining('contour corp is required')],
    });
    expect(decideSetRoute([LOGIN], [GW], required)).toMatchObject({ ok: true, widened: [GW] });
    expect(
      decideSetRoute(
        [GW],
        [GW],
        ports({ contour: { contourId: 'corp', mode: 'required', gateway: 'down' } }),
      ),
    ).toMatchObject({ ok: false, code: 'route_unavailable' });
    expect(
      decideSetRoute(
        [LOGIN],
        [API_KEY],
        ports({ contour: { contourId: 'corp', mode: 'best-effort', gateway: 'down' } }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('applier: judged valid → routes.set line with the widening named; the fold reads it over task.created', async () => {
    const { task: t } = await homeTask({ allowedRoutes: [LOGIN] });
    open.push(t);
    const send = (allowedRoutes: unknown[]) =>
      processCommand(
        t,
        envelope(t, 'set-route', { scope: 'task', scopeId: t.taskId, allowedRoutes }),
        HUMAN_PROOF,
        env(ports()),
      );
    const got = await send([LOGIN, QWEN]);
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { widened: 'qwen/local-own/qwen3-coder', narrowed: 'none' },
    });
    const line = readJournalLines(t.dir, t.taskId).lines.find((l) => l.kind === 'routes.set');
    expect(line?.data).toMatchObject({ allowedRoutes: [LOGIN, QWEN], widened: [QWEN] });
    expect(allowedRoutesOf(t.state)).toEqual([LOGIN, QWEN]);
    expect(t.state.created?.allowedRoutes).toEqual([LOGIN]);
    // Второй суд идёт против набора команды, а не `task.created`: QWEN уже разрешён — не расширение.
    expect(await send([QWEN])).toMatchObject({
      status: 'applied',
      outcome: { widened: 'none', narrowed: expect.stringContaining(LOGIN.route.id) },
    });
    expect(allowedRoutesOf(t.state)).toEqual([QWEN]);
  });

  it('applier refusals: unwired registry, unit scope, refused set, ended task', async () => {
    const { task: t } = await homeTask({ allowedRoutes: [LOGIN] });
    open.push(t);
    const send = (fields: Record<string, unknown>, e: CommandEnv) =>
      processCommand(t, envelope(t, 'set-route', fields), HUMAN_PROOF, e);
    const task = { scope: 'task', scopeId: t.taskId };
    expect(await send({ ...task, allowedRoutes: [QWEN] }, env(undefined))).toMatchObject({
      code: 'routes-unwired',
    });
    expect(
      await send({ scope: 'unit', scopeId: t.taskId, allowedRoutes: [QWEN] }, env(ports())),
    ).toMatchObject({ code: 'unknown-scope' });
    expect(
      await send(
        { ...task, allowedRoutes: [API_KEY] },
        env(ports({ contour: { contourId: 'corp', mode: 'required', gateway: 'up' } })),
      ),
    ).toMatchObject({ code: 'outside-allowed-set' });
    t.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    expect(await send({ ...task, allowedRoutes: [QWEN] }, env(ports()))).toMatchObject({
      status: 'rejected',
    });
  });
});
