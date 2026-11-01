import { join } from 'node:path';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createForgePort } from '../../adapters/forge/index.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { sessionPermitDeny } from '../../adapters/deny-overlay.ts';
import { composeEnv } from '../../adapters/launcher/env.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import {
  guardStep,
  REAL_PUBLISH_TIMEOUT_MS,
  signalsOf,
  type GuardStep,
} from './__fixtures__/guard-stand.ts';

/**
 * P28 корпус, исполненный по-настоящему: сеанс получает окружение `composeEnv` (обёртка ssh,
 * сброс помощников учётных данных) плюс метку дерева, копия закрыта стражем, remote — голый
 * репозиторий, форж — заглушка. Каждая дорога публикации либо отказана (remote не тронут), либо
 * дошла и названа `forged-publish` в конце шага; «прошла молча» — ни одной.
 */

let stub: StubForge;
beforeAll(async () => {
  stub = await startStubForge();
});
afterAll(() => stub.stop());

const open: GuardStep[] = [];
let stand: GuardStep['st'] | null = null;
afterEach(() => {
  for (const one of open.splice(0)) one.done();
  stand = null;
});

async function step() {
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: 'unused' },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const one = await guardStep(port);
  open.push(one);
  const { st, s, hooks } = one;
  stand = st;
  // Окружение сеанса — то же, что строит дорога: пин человека + слой ядра + метка дерева.
  const session = {
    ...composeEnv({ pin: st.env as Record<string, string> }, {}),
    AGENTDECK_TREE: s.stepId,
  };
  expect((await hooks.preStep!(s)).verdict).toEqual({ ok: true });
  const remoteNow = () => st.g(st.copy, 'ls-remote', st.bare);
  const before = remoteNow();
  st.commitIn(st.copy, 'work.txt');
  const sh = (args: string[]) => st.run(st.copy, args, session);
  return { ...one, sh, remoteNow, before };
}

const signals = (t: GuardStep['t']) => signalsOf(t).map((d) => d.detail);

describe(
  'P28 corpus: every publish road is refused or detected',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    const branch = () => `HEAD:refs/heads/${stand!.branch}`;

    it.each([
      [
        'push by remote name (closed pushurl)',
        () => ['push', 'origin', branch()],
        'agentdeck-closed',
      ],
      [
        // `-c` ДОБАВЛЯЕТ значение: закрытый адрес пробуется первым и роняет весь push.
        '-c remote.origin.pushurl=<real> (appended after the closed value)',
        () => ['-c', `remote.origin.pushurl=${stand!.bare}`, 'push', 'origin', branch()],
        'agentdeck-closed',
      ],
      [
        // Remote из `-c` не закрыт адресом — его ловит pre-push по метке сеанса.
        '-c remote.x.url=<real> push x (a remote the closure never saw)',
        () => ['-c', `remote.x.url=${stand!.bare}`, 'push', 'x', branch()],
        'pre-push refused inside a session',
      ],
      ['explicit URL', () => ['push', stand!.bare, branch()], 'pre-push refused inside a session'],
      [
        'ssh URL (session ssh wrapper)',
        () => ['push', 'ssh://git@example.invalid/acme/app.git', branch()],
        'push is a platform step',
      ],
    ])('%s → refused, remote unchanged, step quiet', async (_name, args, said) => {
      const { t, hooks, s, sh, remoteNow, before } = await step();
      const out = sh(args());
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain(said);
      expect(remoteNow()).toBe(before);
      expect((await hooks.postStep!(s, null)).verdict).toEqual({ ok: true });
      expect(signals(t)).toEqual([]);
    });

    it.each([
      ['explicit URL + --no-verify', () => ['push', '--no-verify', stand!.bare, branch()]],
      [
        '-c core.hooksPath=<empty dir>',
        () => ['-c', `core.hooksPath=${join(stand!.root, 'none')}`, 'push', stand!.bare, branch()],
      ],
    ])('%s → lands, detected as forged-publish', async (_name, args) => {
      const { t, hooks, s, sh, remoteNow, before } = await step();
      expect(sh(args()).status).toBe(0);
      expect(remoteNow()).not.toBe(before);
      expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ code: 'forged-publish' });
      expect(signals(t)[0]).toContain('remote-sha: origin');
    });

    it('marker unset (env -u) → lands, detected', async () => {
      const { t, st, hooks, s } = await step();
      // Сеанс снял метку: окружение без неё — тот же git, что у человека.
      expect(st.run(st.copy, ['push', st.bare, `HEAD:refs/heads/${st.branch}`]).status).toBe(0);
      expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ code: 'forged-publish' });
      expect(signals(t)).toHaveLength(1);
    });

    it('forge API write with a planted token → detected by own-account activity', async () => {
      const mr = stub.act('reviewer', {
        type: 'mr-open',
        sourceBranch: 'feature',
        targetBranch: 'main',
        title: 'review target',
      }) as { iid: number };
      const { t, hooks, s } = await step();
      const api = `${stub.url}/api/v4/projects/101`;
      const res = await fetch(`${api}/merge_requests/${mr.iid}/discussions`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': stub.tokens['publisher']!, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'posted around the core' }),
      });
      expect(res.status).toBe(201);
      // Ветка единицы на форже не названа — MR берётся по номеру из журнала: запишем его как свой.
      t.append({
        kind: 'publish.mr',
        actor: 'core',
        unitId: s.unitId,
        data: {
          unitId: s.unitId,
          forge: 'gitlab',
          mrId: String(mr.iid),
          mrIid: mr.iid,
          url: `${stub.url}/mr/${mr.iid}`,
          sourceBranch: 'feature',
          actionId: newId(),
        },
      });
      expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ code: 'forged-publish' });
      expect(signals(t)[0]).toContain(`forge-event: note !${mr.iid} by publisher`);
      // Заглушка не знает записи без действия журнала, кроме названной выше.
      const writes = stub.requests.filter((r) => r.method !== 'GET' && !r.control);
      expect(writes.map((r) => r.tokenId)).toEqual(['publisher']);
    });

    it.each([
      ['gh pr create', 'gh pr create --fill'],
      ['glab mr create', 'glab mr create --fill'],
      ['git push in a chain', 'echo ok && git push origin HEAD'],
    ])('%s → refused by permit before it runs', async (_name, command) => {
      const { st } = await step();
      const { deny, platformPaths } = sessionPermitDeny(
        { coreHome: join(st.root, 'core-home'), tokenFiles: [], forgeMcpTools: ['mcp__forge__*'] },
        { paths: [], commands: [], mcpTools: [], tools: [] },
        st.copy,
      );
      const ctx = {
        copyRoot: st.copy,
        ownedPaths: [],
        deny,
        platformPaths,
        endpointSources: [],
        grantRequired: [],
        grants: [],
      };
      const verdict = decidePermit(mapClaudePermission({ tool: 'Bash', input: { command } }), ctx);
      expect(verdict).toMatchObject({ allow: false });
      const mcp = decidePermit(
        mapClaudePermission({ tool: 'mcp__forge__create_merge_request', input: {} }),
        ctx,
      );
      expect(mcp).toMatchObject({ allow: false });
    });
  },
);
