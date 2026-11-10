import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { ActOutcome, ActRefusal } from '../adapters/browser/browser.types.ts';
import {
  chromiumAvailable,
  NO_CHROMIUM_REASON,
} from '../adapters/browser/__fixtures__/chromium.ts';
import { startStandSite, type StandSite } from '../adapters/browser/__fixtures__/stand-site.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Страница прохода живёт не дольше своей сессии (этап 12, P177): дорога сессии закрывает её,
 * как только поток сессии кончился, а конец задачи — страницы всех её сессий. Настоящая загрузка
 * ядра (одноразовый дом, без панели), настоящий Chromium её браузера, CLI — подставной (запись
 * живого Claude). До этого страница держалась до 15 минут тишины или остановки ядра.
 */

const hasChromium = await chromiumAvailable();
if (!hasChromium) console.warn(`walk-release: skipped — ${NO_CHROMIUM_REASON}`);

const cores: BootedCore[] = [];
const stops: (() => Promise<unknown>)[] = [];
let site: StandSite;

beforeAll(async () => {
  site = await startStandSite();
});

afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  for (const core of cores) await core.stop();
  await site?.close();
});

interface Bench {
  core: BootedCore;
  live: LiveRoot;
  bin: string;
}

async function bench(): Promise<Bench> {
  const core = await bootCore({
    home: join(tempDir('walk-release-'), 'core'),
    build: 'walk-release-test',
    panelAppData: null,
  });
  cores.push(core);
  const live = liveRoot('walk-release-');
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  return { core, live, bin };
}

function outcome(got: ActOutcome | ActRefusal): ActOutcome {
  if ('refused' in got) throw new Error(`refused: ${got.refused} ${got.message}`);
  return got;
}

/** Сессия дорогой ядра: подготовка, запуск, запись, прикрепление — как у исполнителя. */
async function attachedSession(b: Bench, task: LiveTask) {
  const start = roadStart({
    live: b.live,
    bin: b.bin,
    task,
    adapterId: claudeRunFacts.id,
    fixture: fixturePath(claudeRunFacts.id, 'permit'),
    dump: join(b.live.root, `dump-${task.taskId}.json`),
  });
  const prepared = await b.core.road.prepare(start);
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  const launched = await b.core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  stops.push(() => p.adapter.stop(launched.handle, 'tree'));
  b.core.road.started(p, launched.handle, launched.layer);
  const session = b.core.road.attach({
    task,
    sessionId: p.start.sessionId,
    adapter: p.adapter,
    handle: launched.handle,
    context: p.context,
    cwd: p.start.cwd,
  });
  return { sessionId: p.start.sessionId, session };
}

async function until(probe: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!hasChromium)('walk page release on the session road (stage 12, P177)', () => {
  it('a walk session ends → its page is closed, the driver holds no page for it; another session keeps its own', async () => {
    const b = await bench();
    const task = await roadTask(b.core, claudeRunFacts.id);
    const one = await attachedSession(b, task);
    const two = await attachedSession(b, task);
    const { driver } = b.core.walk;
    outcome(await driver.act(one.sessionId, { action: 'open', url: `${site.url}/login` }));
    outcome(await driver.act(two.sessionId, { action: 'open', url: `${site.url}/inert` }));
    expect(driver.urlOf(one.sessionId)).toBe(`${site.url}/login`);

    await one.session.end('tree');
    await until(() => driver.urlOf(one.sessionId) === null);
    expect(driver.urlOf(two.sessionId)).toBe(`${site.url}/inert`);
    // Следующее действие той же сессии — уже новая пустая страница: прежняя закрыта со входом.
    const fresh = outcome(await driver.act(one.sessionId, { action: 'snapshot' }));
    expect(fresh.url).toBe('about:blank');
    await driver.release(one.sessionId);
    await two.session.end('tree');
  }, 120_000);

  it('a task end closes the pages of every session of the task, also one the road never ended', async () => {
    const b = await bench();
    const task = await roadTask(b.core, claudeRunFacts.id);
    const held = await attachedSession(b, task);
    const { driver } = b.core.walk;
    outcome(await driver.act(held.sessionId, { action: 'open', url: `${site.url}/login` }));
    // Сессия прикреплена прежним путём и не снята дорогой (её поток ещё жив) — конец задачи всё
    // равно закрывает её страницу.
    const released = await b.core.road.releaseTask(task);
    expect(released.leaks).toEqual([]);
    expect(driver.urlOf(held.sessionId)).toBeNull();
    await held.session.end('tree');
  }, 120_000);
});
