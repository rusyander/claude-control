import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { CaptureAnswer, CaptureResult } from '@agentdeck/contracts/core/records';
import { captureWiring } from '../../bootstrap/verifier-wiring/capture.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { ensureCaptureToken } from '../../platform/capture-shim.ts';
import { layoutOf, type CoreHomeLayout } from '../../platform/core-home.ts';
import type { ProcessTableSource } from '../../platform/process-table.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import { createNonceStore } from '../../policy/authority/nonce.ts';
import {
  createSessionTokens,
  type SessionTokens,
} from '../../policy/session-tokens/session-tokens.ts';
import type { SpoolSink } from '../../verifier/spool/ingest.ts';
import { buildApi } from '../server.ts';
import type {
  CaptureCheckAsk,
  CaptureEntry,
  CaptureResultOwner,
} from '../session-capture.types.ts';

/**
 * Стенд ручки захвата: настоящий API ядра (`buildApi`), настоящая сборка зоны D
 * (`captureWiring` → `registerSessionCapture`, псевдозадачи, забор очереди), настоящие токены
 * сессий и доступ захвата в доме ядра песочницы, настоящий журнал задачи с сессией. Подменён
 * только вход проверок зоны C (волна 2: `requestCheck` ещё не собран) — записывающим входом:
 * первый вопрос ключа — прогон под арендой, итог пишет лог на диск, следующий вопрос того же
 * ключа — повтор этого лога. Ключ — argv + каталог + хеш окружения, как у входа проверок.
 */

export interface RecordingEntry extends CaptureEntry {
  asks: CaptureCheckAsk[];
  results: { owner: CaptureResultOwner; result: CaptureResult }[];
}

export function recordingEntry(dir: string): RecordingEntry {
  const records = new Map<string, { exit: number; logPath: string; recordId: string }>();
  const leases = new Map<string, string>();
  const asks: CaptureCheckAsk[] = [];
  const results: RecordingEntry['results'] = [];
  const keyOf = (ask: CaptureCheckAsk): string =>
    JSON.stringify([ask.taskId, ask.argv, ask.cwd, ask.envDigest]);
  return {
    asks,
    results,
    async ask(ask): Promise<CaptureAnswer> {
      asks.push(ask);
      const key = keyOf(ask);
      const known = records.get(key);
      if (known) {
        return {
          kind: 'replay',
          recordId: known.recordId,
          exit: known.exit,
          logPath: known.logPath,
          header: `recorded run ${known.recordId}`,
        };
      }
      const leaseId = newId();
      leases.set(leaseId, key);
      return {
        kind: 'run',
        leaseId,
        checkRunId: newId(),
        resultUrl: '/v1/session/capture/result',
      };
    },
    async result(owner, result) {
      results.push({ owner, result });
      const key = leases.get(result.leaseId);
      if (!key) return { refused: 'unknown lease' };
      leases.delete(result.leaseId);
      const recordId = newId();
      const logPath = join(dir, `${recordId}.log`);
      writeFileSync(logPath, result.log);
      records.set(key, { exit: result.exit ?? 1, logPath, recordId });
      return { taken: true };
    },
  };
}

export interface CaptureStand {
  url: string;
  port: number;
  layout: CoreHomeLayout;
  registry: TaskRegistry;
  task: LiveTask;
  tokens: SessionTokens;
  sessionToken: string;
  captureToken: string;
  session: { unitId: string; stepId: string; sessionId: string };
  notes: { event: string; data: Record<string, unknown> }[];
  close(): Promise<void>;
}

export interface CaptureStandOptions {
  /** Дом ядра другого стенда — «перезапуск ядра» над теми же файлами. */
  root?: string;
  entry?: CaptureEntry;
  sink?: SpoolSink;
  table?: ProcessTableSource;
  images?: () => readonly string[];
}

export async function startCaptureStand(opts: CaptureStandOptions = {}): Promise<CaptureStand> {
  const root = opts.root ?? tempDir('capture-home-');
  const layout = layoutOf(root);
  ensureDir(layout.tasks);
  const registry = createTaskRegistry(layout.tasks, deps());
  const task = await registry.create(CREATED);
  const coreToken = randomBytes(24).toString('base64url');
  const tokens = createSessionTokens(coreToken);
  const session = seedSession(task, { stepKind: 'work' });
  const sessionToken = tokens.mint({ taskId: task.taskId, sessionId: session.sessionId });
  const access = ensureCaptureToken(root);
  const notes: CaptureStand['notes'] = [];
  const app = buildApi({
    registry,
    tokens: { core: coreToken, isSessionToken: (t) => tokens.verify(t) !== undefined },
    nonces: createNonceStore(),
    peer: {
      peerPid: async () => ({ value: process.pid }),
      isSessionDescendant: async () => false,
      trustedHopPids: new Set(),
    },
    signature: { machineId: 'machine-test', devices: () => [], now: Date.now },
    health: { build: 'test', bootId: newId(), pid: process.pid, startedAt: Date.now(), home: root },
    now: Date.now,
    pingMs: 60_000,
  });
  captureWiring({
    registry,
    layout,
    ...(opts.entry ? { entry: opts.entry } : {}),
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.table ? { table: opts.table } : {}),
    ...(opts.images ? { images: opts.images } : {}),
    note: (event, data) => notes.push({ event, data }),
  }).register(app, tokens);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    layout,
    registry,
    task,
    tokens,
    sessionToken,
    captureToken: access.token,
    session,
    notes,
    async close() {
      await app.close();
      registry.closeAll();
      if (!opts.root)
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
