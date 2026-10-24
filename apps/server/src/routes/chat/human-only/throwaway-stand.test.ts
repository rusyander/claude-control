import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { ProcessFact } from '../../../lib/peer-process/process-facts.ts';
import { localVerdict, standTrusts } from './human-gate.ts';
import { checkHumanCaller } from './human-only.ts';
import {
  CLI,
  DETACHED,
  deps,
  facts,
  gate,
  LAUNCHER,
  MODEL_BROWSER,
  PANEL,
  PW_NET,
  PW_ROOT,
  request,
  WINDOWS,
} from './human-gate.fixture.ts';
import { isAutomationBrowserName, isThrowawayStand, osTempRoots } from './throwaway-stand.ts';

/**
 * Шов одноразового стенда (решение координатора 24.10): браузер автоматизации и
 * линия процессов, поднявших панель, сходят за человека ТОЛЬКО когда каталог
 * данных панели и каталог конфигурации Claude оба лежат во временном каталоге
 * ОС. Корень temp берётся из учётной записи, не из окружения; соединение
 * каталогов из temp наружу шва не открывает; прогон модели и отвязанный
 * помощник отбиваются и на стенде.
 */

let root = '';
let config = '';
let data = '';
/** Каталог вне temp: сам репозиторий. */
const outside = realpathSync(process.cwd());

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-stand-')));
  config = join(root, '.claude');
  data = join(root, '.agentdeck');
  mkdirSync(config);
  mkdirSync(data);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}x`, { recursive: true, force: true });
});

describe('isThrowawayStand (real file system)', () => {
  it('both dirs inside a temp root are a stand', () => {
    expect(isThrowawayStand({ config, data }, [root])).toBe(true);
  });

  it('one dir outside temp, a missing data dir, the root itself or no dirs are not', () => {
    expect(isThrowawayStand({ config: outside, data }, [root])).toBe(false);
    expect(isThrowawayStand({ config, data: outside }, [root])).toBe(false);
    expect(isThrowawayStand({ config, data: join(root, 'missing') }, [root])).toBe(false);
    expect(isThrowawayStand({ config: root, data }, [root])).toBe(false);
    expect(isThrowawayStand(undefined, [root])).toBe(false);
    expect(isThrowawayStand({ config, data }, [])).toBe(false);
  });

  it('a junction from temp to a real dir leads outside and does not open the seam', () => {
    const link = join(root, 'link-out');
    symlinkSync(outside, link, 'junction');
    expect(isThrowawayStand({ config: link, data }, [root])).toBe(false);
  });

  it('a stand without Claude: a missing config dir whose path resolves inside temp is a stand, one leading outside is not', () => {
    const home = join(root, 'home-no-claude');
    mkdirSync(home);
    expect(isThrowawayStand({ config: join(home, '.claude'), data }, [root])).toBe(true);
    expect(isThrowawayStand({ config: join(home, 'a', 'b', '.claude'), data }, [root])).toBe(true);
    expect(isThrowawayStand({ config: join(outside, 'missing-claude'), data }, [root])).toBe(false);
    // Предок пропавшего каталога — соединение наружу: разрешённый путь за пределами temp.
    const link = join(root, 'link-home');
    symlinkSync(outside, link, 'junction');
    expect(isThrowawayStand({ config: join(link, '.claude'), data }, [root])).toBe(false);
    // `..` в пропавшем хвосте сворачивается до проверки и наружу не выводит.
    const escape = [home, 'x', '..', '..', '..', 'escape'].join(sep);
    expect(isThrowawayStand({ config: escape, data }, [root])).toBe(false);
  });

  it('a sibling that only shares the prefix of the root is not inside it', () => {
    mkdirSync(`${root}x`);
    expect(isThrowawayStand({ config: `${root}x`, data }, [root])).toBe(false);
  });

  it('the temp root comes from the OS account, not from TEMP/TMP/TMPDIR/HOME/USERPROFILE', () => {
    const names = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = outside;
    try {
      const roots = osTempRoots();
      expect(roots.length).toBeGreaterThan(0);
      const lower = (value: string) => value.toLowerCase();
      for (const dir of roots) {
        expect(lower(outside).startsWith(lower(dir))).toBe(false);
        expect(lower(dir).startsWith(lower(outside))).toBe(false);
      }
      // Каталоги в «temp» из окружения — это репозиторий: шва нет.
      expect(isThrowawayStand({ config: outside, data: outside })).toBe(false);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

describe('isAutomationBrowserName', () => {
  it.each([
    ['chrome.exe', true],
    ['msedge.exe', true],
    ['headless_shell.exe', true],
    ['chrome-headless-shell', true],
    ['Google Chrome for Testing', true],
    ['firefox', true],
    ['node.exe', false],
    ['mychrome.exe', false],
    ['chrome.exe.bak', false],
    ['powershell.exe', false],
  ])('%s → %s', (name, expected) => {
    expect(isAutomationBrowserName(name)).toBe(expected);
  });
});

/** Chromium Playwright из `ms-playwright`: не установка браузера, с ключами автоматизации. */
const PLAYWRIGHT_EXE =
  'C:\\Users\\owner\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win\\chrome.exe';
const PW_OWN: ProcessFact = {
  pid: PW_ROOT,
  name: 'chrome.exe',
  session: 1,
  path: PLAYWRIGHT_EXE,
  commandLine: `"${PLAYWRIGHT_EXE}" --enable-automation --remote-debugging-pipe`,
  argv: [PLAYWRIGHT_EXE, '--enable-automation', '--remote-debugging-pipe'],
};

describe('the seam inside the gate', () => {
  const stand = { stand: { self: PANEL } };

  it('a Playwright browser passes only on the stand', () => {
    expect(localVerdict(PW_NET, gate())).toBe('unverified');
    expect(localVerdict(PW_NET, gate(stand))).toBe('human');
    const own = gate({ ...stand, facts: facts([...WINDOWS.values()].concat(PW_OWN)) });
    expect(localVerdict(PW_ROOT, own)).toBe('human');
    expect(localVerdict(PW_ROOT, { ...own, stand: undefined })).toBe('unverified');
  });

  it('the live line that started the panel passes on the stand, a detached helper does not', () => {
    expect(standTrusts(LAUNCHER, gate(stand))).toBe(true);
    expect(localVerdict(PANEL, gate(stand))).toBe('human');
    expect(localVerdict(LAUNCHER, gate())).toBe('unverified');
    expect(localVerdict(DETACHED, gate(stand))).toBe('unverified');
  });

  it('a run process stays the model on the stand, its browser too', () => {
    expect(localVerdict(CLI, gate(stand))).toBe('model-process');
    expect(localVerdict(MODEL_BROWSER, gate(stand))).toBe('model-process');
  });

  it('checkHumanCaller opens the seam by the panel dirs; a seam pass is remembered for the stand only, refused after the dirs move', async () => {
    const known = new Set<string>();
    const knownStand = new Set<string>();
    const onStand = {
      ...deps(PW_NET, { known, knownStand }),
      panelDirs: () => ({ config, data }),
      standRoots: () => [root],
      self: PANEL,
    };
    expect(await checkHumanCaller(request(), onStand)).toEqual({ ok: true });
    expect(await checkHumanCaller(request(), onStand)).toEqual({ ok: true });
    expect(onStand.counter.facts).toBe(1);
    expect(known.size).toBe(0);
    expect([...knownStand]).toEqual([`${PW_NET}:${PW_NET}`]);
    // Каталоги переехали: запомненный пропуск шва не действует, звонящий судится заново.
    const real = { ...onStand, panelDirs: () => ({ config: outside, data }) };
    expect(await checkHumanCaller(request(), real)).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
    expect(real.counter.facts).toBe(2);
    // Тот, кто поднял панель стенда (проверка), — на линии предков панели.
    const launcher = { ...onStand, ...deps(LAUNCHER, { known, knownStand }) };
    expect(await checkHumanCaller(request(), launcher)).toEqual({ ok: true });
    const detached = { ...onStand, ...deps(DETACHED, { known, knownStand }) };
    expect(await checkHumanCaller(request(), detached)).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
    expect(known.size).toBe(0);
  });

  it('checkHumanCaller on a stand without Claude: the missing config dir inside temp opens the seam, one outside temp does not', async () => {
    const noClaude = {
      ...deps(PW_NET),
      panelDirs: () => ({ config: join(root, 'home-gate', '.claude'), data }),
      standRoots: () => [root],
      self: PANEL,
    };
    expect(await checkHumanCaller(request(), noClaude)).toEqual({ ok: true });
    const off = {
      ...noClaude,
      panelDirs: () => ({ config: join(outside, 'missing-claude'), data }),
    };
    expect(await checkHumanCaller(request(), off)).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
  });
});
