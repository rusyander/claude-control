import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { PERMIT_MCP_SERVER, PERMIT_TOOL } from '@agentdeck/contracts/core/model-tools';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { sessionPermitDeny } from '../../adapters/deny-overlay.ts';
import { SDK_PERMIT_CODEC } from '../../adapters/sdk-stream/permit-codec.ts';
import type { PeerDeps } from '../../api/auth.ts';
import { buildApi } from '../../api/server.ts';
import { registerSessionTools } from '../../api/session-tools.ts';
import { seedSession, toolDeps } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createNonceStore, type NonceStore } from '../../policy/authority/nonce.ts';
import { createPendingPermits, type PendingPermits } from '../../policy/permit/pending.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import {
  createSessionTokens,
  type SessionTokens,
} from '../../policy/session-tokens/session-tokens.ts';

/**
 * Стенд ручек сессии: настоящий API ядра (`buildApi`) + `registerSessionTools`, настоящий
 * журнал в песочнице, НАСТОЯЩИЕ токены сессий (HMAC от токена ядра) и настоящий ворот права.
 * Подменён только пир, если тест не дал свой: прямой pid — сам тест, дерево сессии — набор.
 */

export const PERMIT_SELF = `mcp__${PERMIT_MCP_SERVER}__${PERMIT_TOOL}`;

export interface SessionStand {
  url: string;
  port: number;
  registry: TaskRegistry;
  task: LiveTask;
  nonces: NonceStore;
  gate: PendingPermits;
  tokens: SessionTokens;
  coreToken: string;
  sessionToken: string;
  session: { unitId: string; stepId: string; sessionId: string };
  copyRoot: string;
  close(): Promise<void>;
}

export interface SessionStandOptions {
  stepKind?: string;
  peer?: PeerDeps;
  tasksDir?: string;
  coreToken?: string;
  port?: number;
}

export async function startSessionStand(opts: SessionStandOptions = {}): Promise<SessionStand> {
  const tasksDir = opts.tasksDir ?? tempDir('session-');
  const registry = createTaskRegistry(tasksDir, deps());
  const task = await registry.create(CREATED);
  const coreToken = opts.coreToken ?? randomBytes(24).toString('base64url');
  const tokens = createSessionTokens(coreToken);
  const session = seedSession(task, { stepKind: opts.stepKind ?? 'work' });
  const sessionToken = tokens.mint({ taskId: task.taskId, sessionId: session.sessionId });
  const nonces = createNonceStore();
  const gate = createPendingPermits({ selfToolNames: [PERMIT_SELF] });
  const copyRoot = tempDir('copy-');
  // Запреты судьи — тот же набор, что оверлей CLI получает при запуске (F-11), не список рукой.
  const permitDeny = sessionPermitDeny(
    { coreHome: tasksDir, tokenFiles: [] },
    { paths: [], commands: [['git', 'push']], mcpTools: [PERMIT_SELF], tools: [] },
    copyRoot,
  );
  const context: PermitContext = {
    copyRoot,
    ownedPaths: [],
    deny: permitDeny.deny,
    platformPaths: permitDeny.platformPaths,
    endpointSources: [],
    grantRequired: [],
    grants: [],
  };
  const peer: PeerDeps = opts.peer ?? {
    peerPid: async () => ({ value: process.pid }),
    isSessionDescendant: async () => false,
    trustedHopPids: new Set(),
  };
  const app = buildApi({
    registry,
    tokens: { core: coreToken, isSessionToken: (t) => tokens.verify(t) !== undefined },
    nonces,
    peer,
    signature: { machineId: 'machine-test', devices: () => [], now: Date.now },
    health: {
      build: 'test',
      bootId: newId(),
      pid: process.pid,
      startedAt: Date.now(),
      home: tasksDir,
    },
    now: Date.now,
    pingMs: 60_000,
  });
  registerSessionTools(app, {
    registry,
    tokens,
    tools: toolDeps(),
    permitDeps: () => ({
      gate,
      codec: SDK_PERMIT_CODEC,
      mapPermission: mapClaudePermission,
      context,
      settleMs: 150,
    }),
  });
  await app.listen({ host: '127.0.0.1', port: opts.port ?? 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registry,
    task,
    nonces,
    gate,
    tokens,
    coreToken,
    sessionToken,
    session,
    copyRoot,
    async close() {
      await app.close();
      registry.closeAll();
      // Свои временные каталоги стенд уносит сам (F-123); чужой `tasksDir` (перезапуск панели
      // над тем же домом) — забота того, кто его дал.
      for (const dir of [copyRoot, ...(opts.tasksDir ? [] : [tasksDir])])
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
