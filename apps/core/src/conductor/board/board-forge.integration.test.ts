import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEntry, BoardEntryDraft } from '@agentdeck/contracts/core/board';
import { createBoardWiring, type BoardWiring } from '../../bootstrap/board-wiring.ts';
import type { AllocatorWiring } from '../../bootstrap/allocator-wiring/index.ts';
import { createConfigPort } from '../../bootstrap/core-config/port.ts';
import type { BootEconomy } from '../../bootstrap/economy-wiring/boot-economy.ts';
import {
  closeWorlds,
  linesOf,
  world,
  type World,
} from '../../bootstrap/forge-wiring/__fixtures__/answer-world.ts';
import { createReviewLinkWiring } from '../../bootstrap/review-link-wiring/index.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';

/**
 * Доска и форж (этап 12, B3 ссылка + B10a): заглушка форжа (`@agentdeck/stub-forge`) на loopback,
 * голый «сервер» и основной репозиторий во временной папке, настоящий публикатор открыл MR
 * источника. Ссылка на этот MR стартует с доски через настоящую проводку доски и настоящее ревью по
 * ссылке; заголовок MR в `publish.mr` — тот, с которым публикатор открывал MR у форжа.
 */

const wirings: BoardWiring[] = [];
afterEach(async () => {
  for (const w of wirings.splice(0)) await w.stop();
  await closeWorlds();
});

function boardOver(w: World): BoardWiring {
  const link = createReviewLinkWiring(
    { registry: w.registry, coreHome: w.layout.root },
    { git: w.git, forgeFor: () => ({ port: w.port, credential: null }) },
  );
  const config = createConfigPort({ layout: w.layout, note: () => undefined });
  const wiring = createBoardWiring({
    registry: w.registry,
    layout: w.layout,
    note: () => undefined,
    split: () => w.env,
    reviewLink: () => link,
    config: config.port,
    economy: { ladders: {} } as unknown as BootEconomy,
    windows: new WindowBook(),
    allocator: {} as AllocatorWiring,
    now: Date.now,
  });
  wiring.start();
  wirings.push(wiring);
  return wiring;
}

async function mrUrl(w: World): Promise<string> {
  const mr = await w.port.mr(w.mrIid);
  if (!('value' in mr)) throw new Error(`mr: ${JSON.stringify(mr)}`);
  return mr.value.url;
}

async function queued(
  wiring: BoardWiring,
  draft: BoardEntryDraft,
): Promise<{ id: string; cmdId: string }> {
  const cmdId = newId();
  const got = await wiring.port()!.entries({ cmdId, to: 'queue', entries: [draft] });
  if (!got.ok) throw new Error(got.problems.join('; '));
  await wiring.idle();
  await wiring.idle();
  return { id: got.reply.created[0]!, cmdId };
}

async function entryOf(wiring: BoardWiring, id: string): Promise<BoardEntry> {
  const e = (await wiring.port()!.read()).entries.find((x) => x.entryId === id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
}

describe('board start by MR link (B3, P156)', () => {
  it('a queued link starts review-link through the real review-by-link path; task.created carries boardEntry', async () => {
    const w = await world();
    const wiring = boardOver(w);
    const url = await mrUrl(w);
    const { id, cmdId } = await queued(wiring, {
      preset: 'review-link',
      source: { kind: 'manual', title: 'Review the feature MR' },
      launch: { kind: 'link', mrUrl: url, repo: w.st.main },
    });
    const e = await entryOf(wiring, id);
    expect([e.state, e.reason]).toEqual(['started', undefined]);
    const created = readJournalLines(join(w.layout.tasks, e.taskId!), e.taskId!).lines.find(
      (l) => l.kind === 'task.created',
    )!.data as Record<string, unknown>;
    expect(created.scenario).toEqual({ id: 'review-link', version: 1 });
    expect(created.boardEntry).toEqual({
      entryId: id,
      stop: 'mr',
      source: 'manual',
      proof: { kind: 'human', cmdId },
    });
    // Ключ повтора старта — `cmdId` записи: тот же путь, что у человека с той же ссылкой.
    expect(created.origin).toEqual({ cmdId: e.cmdId });
  });

  it('a link with no local repository goes back to the inbox with the reason; no task opened', async () => {
    const w = await world();
    const wiring = boardOver(w);
    const before = w.registry.liveTasks().length;
    const { id } = await queued(wiring, {
      preset: 'review-link',
      source: { kind: 'manual', title: 'No repo' },
      launch: { kind: 'link', mrUrl: await mrUrl(w) },
    });
    const e = await entryOf(wiring, id);
    expect(e.state).toBe('inbox');
    expect(e.reason).toBe('no local repository for the MR link');
    expect(w.registry.liveTasks()).toHaveLength(before);
  });
});

describe('MR title on publish.mr (B10a)', () => {
  it('publish.mr carries the title the publisher opened the MR with at the forge', async () => {
    const w = await world();
    const [line] = linesOf(w.source, 'publish.mr');
    // Заголовок — из состояния самого форжа: с ним публикатор открыл MR через API.
    const atForge = w.stub.state().mrs.find((m) => m.iid === w.mrIid);
    expect(atForge?.title).toBeTruthy();
    expect(line?.title).toBe(atForge?.title);
    expect(line?.title).not.toBe(w.branch);
  });
});
