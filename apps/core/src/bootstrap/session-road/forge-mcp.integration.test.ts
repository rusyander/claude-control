import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { roadStart, roadTask } from '../__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from '../boot.ts';

/**
 * Правило `forge-mcp-read-only` (P82) на НАСТОЯЩЕЙ загрузке ядра без установленного CLI (идёт и в
 * Linux-контейнере): чат панели (chat@1) дорогой ядра — `prepare` читает `~/.claude.json` человека,
 * каталог панели с сайтом GitLab своей инсталляции даёт хост форжа (`forgeHostsOfPanel` в
 * загрузке), сессия запускается подставным CLI и прикрепляется, решения идут через настоящую ручку
 * хука ядра `POST /v1/session/hook` с токеном сессии. Живой Claude Code с моделью-заглушкой —
 * `forge-mcp.live.integration.test.ts`.
 */

const SITE = 'git.corp.example';
const BY_NAME = 'gitlab-x';
const BY_HOST = 'company';
const PLAIN = 'notes';

let core: BootedCore;
let live: LiveRoot;
let task: LiveTask;
let token = '';
let sessionId = '';
let stop: () => Promise<unknown> = async () => undefined;

beforeAll(async () => {
  const root = tempDir('road-forge-mcp-');
  const panel = join(root, 'panel');
  mkdirSync(panel, { recursive: true });
  writeFileSync(
    join(panel, 'state.json'),
    JSON.stringify({
      settings: {
        integrations: { gitlab: { enabled: true, baseUrl: `https://${SITE}`, repo: '' } },
      },
    }),
  );
  core = await bootCore({ home: join(root, 'core'), build: 'forge-mcp-test', panelAppData: panel });
  live = liveRoot('road-forge-mcp-');
  writeFileSync(
    join(live.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        [BY_NAME]: { type: 'stdio', command: 'gl-cmd' },
        [BY_HOST]: {
          type: 'stdio',
          command: 'company-cmd',
          env: { API_URL: `https://${SITE}/api/v4` },
        },
        [PLAIN]: { type: 'stdio', command: 'notes-cmd' },
      },
    }),
  );
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  // Запись живого CLI до ответа инструмента: сессия жива и ждёт, пока ручка хука отвечает.
  const full = readFileSync(fixturePath(claudeRunFacts.id, 'permit'), 'utf8').split('\n');
  const cut = full.findIndex((l) => l.includes('"tool_result"'));
  const fixture = join(live.root, 'pending.jsonl');
  writeFileSync(fixture, `${full.slice(0, cut).join('\n')}\n`);
  task = await roadTask(core, claudeRunFacts.id);
  const prepared = await core.road.prepare({
    ...roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture,
      dump: join(live.root, 'dump.json'),
    }),
    stepKind: 'chat',
  });
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  token = p.token;
  sessionId = p.spec.sessionId;
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  const handle = launched.handle;
  stop = () => p.adapter.stop(handle, 'tree');
  core.road.started(p, handle, launched.layer);
  core.road.attach({
    task,
    sessionId,
    adapter: p.adapter,
    handle,
    context: p.context,
    cwd: p.spec.cwd,
    onEvent: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  await stop().catch(() => undefined);
  await core?.stop();
}, 120_000);

async function hook(tool: string): Promise<{ allow?: boolean; reason?: string }> {
  const res = await fetch(`${core.url}/v1/session/hook`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, input: {} }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { allow?: boolean; reason?: string };
}

const mcp = (server: string, tool: string): string => `mcp__${server}__${tool}`;

describe('core road + real hook endpoint: forge-mcp-read-only (P82)', () => {
  it('the journal names both forge servers with their evidence; the plain one is not named', () => {
    const note = readJournalLines(task.dir, task.taskId).lines.find(
      (l) => l.kind === 'signal' && (l.data as { signal?: string }).signal === 'mcp-human',
    ) as { data?: { detail?: string } } | undefined;
    expect(note?.data?.detail).toContain(
      `forge read-only: ${BY_HOST} (env API_URL names the configured forge ${SITE}), ${BY_NAME} (name has «gitlab»)`,
    );
  });

  it.each([
    [mcp(BY_NAME, 'create_merge_request'), 'a forge write'],
    [mcp(BY_HOST, 'push_files'), 'a forge write'],
    [mcp(BY_HOST, 'gitlab_api_request'), 'not proven read-only'],
  ])('%s → refused (%s)', async (tool, why) => {
    const got = await hook(tool);
    expect(got.allow, got.reason).toBe(false);
    expect(got.reason).toContain('forge-mcp-read-only');
    expect(got.reason).toContain(why);
  });

  it.each([
    mcp(BY_NAME, 'get_merge_request'),
    mcp(BY_HOST, 'list_issues'),
    mcp(PLAIN, 'create_note'),
  ])('%s → allowed', async (tool) => {
    const got = await hook(tool);
    expect(got.allow, got.reason).toBe(true);
  });

  it('each refusal is a journaled permit decision with code forge-mcp-write', () => {
    const codes = readJournalLines(task.dir, task.taskId)
      .lines.filter(
        (l) =>
          l.kind === 'decision' &&
          l.sessionId === sessionId &&
          (l.data as { class?: string }).class === 'permit',
      )
      .map((l) => (l.data as unknown as { output: { target: string; code?: string } }).output)
      .filter((o) => o.code === 'forge-mcp-write')
      .map((o) => o.target)
      .sort();
    expect(codes).toEqual(
      [
        mcp(BY_HOST, 'gitlab_api_request'),
        mcp(BY_HOST, 'push_files'),
        mcp(BY_NAME, 'create_merge_request'),
      ].sort(),
    );
  });
});
