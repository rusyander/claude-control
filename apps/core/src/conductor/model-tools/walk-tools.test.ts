import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseGap, BrowseStep } from '@agentdeck/contracts/core/browse';
import type { ModelToolReply } from '@agentdeck/contracts/core/model-tools';
import { environmentSecretsKey } from '@agentdeck/keys/environment-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import {
  chromiumAvailable,
  NO_CHROMIUM_REASON,
} from '../../adapters/browser/__fixtures__/chromium.ts';
import {
  sha256,
  startHitCounter,
  startStandSite,
  type StandSite,
} from '../../adapters/browser/__fixtures__/stand-site.ts';
import { createWalkPort, type WalkPort } from '../../adapters/browser/index.ts';
import { createSessionKeyBook, type SessionKeyBook } from '../../bootstrap/session-keys.ts';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { seedSession, toolDeps } from './__fixtures__/seed.ts';
import { handleModelTool } from './model-tools.ts';
import type { ModelToolDeps, SessionBinding } from './model-tools.types.ts';
import { WALK_NOT_WIRED } from './walk-tools.ts';

/**
 * Инструменты прохода над настоящим Chromium и своим стендом на 127.0.0.1 (R1/R2, P177/P178).
 * Главное свойство: значение секрета стенда доходит до страницы (стенд печатает его sha256), но
 * не лежит ни в одном файле задачи, ни в одном ответе модели, ни в снимке дерева.
 */

const hasChromium = await chromiumAvailable();
if (!hasChromium) console.warn(`walk-tools: real-browser cases skipped — ${NO_CHROMIUM_REASON}`);

/** 6 символов: короче порога маски выходов (8) — прятать его обязана маска прохода. */
const PASSWORD = 'Qz7-pw';
const TOKEN = 'tok-9f3e2d1c';

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

interface Bench {
  task: LiveTask;
  b: SessionBinding;
  deps: ModelToolDeps;
}

let site: StandSite;
let walk: WalkPort;
let book: SessionKeyBook;
let appData: string;
let root: string;

async function bench(opts: { walk?: WalkPort | null; root?: string } = {}): Promise<Bench> {
  const { task, taskId } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: opts.root ?? root, baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'walk' });
  const b: SessionBinding = { taskId, ...seeded, stepKind: 'walk' };
  const w = opts.walk === undefined ? walk : opts.walk;
  return { task, b, deps: { ...toolDeps(), ...(w ? { walk: w } : {}) } };
}

const call = (x: Bench, name: string, input: unknown): Promise<ModelToolReply> =>
  Promise.resolve(handleModelTool(x.task, x.b, name, input, x.deps));

const rowsOf = (task: LiveTask) => {
  const lines = readJournalLines(task.dir, task.taskId).lines;
  return {
    steps: lines.filter((l) => l.kind === 'browse.step').map((l) => l.data as BrowseStep),
    gaps: lines.filter((l) => l.kind === 'browse.gap').map((l) => l.data as BrowseGap),
  };
};

beforeAll(async () => {
  site = await startStandSite();
  root = temp('walk-proj-');
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'environments.json'),
    JSON.stringify({
      version: 1,
      environments: [
        {
          id: 'local',
          title: 'local',
          baseUrl: site.url,
          secrets: [{ name: 'STAND_PASSWORD' }, { name: 'STAND_TOKEN' }, { name: 'SHORT' }],
        },
        {
          id: 'elsewhere',
          title: 'elsewhere',
          baseUrl: 'http://127.0.0.1:9',
          secrets: [{ name: 'FAR_PASSWORD' }],
        },
      ],
    }),
  );
  appData = temp('walk-app-');
  setStoredKey(
    appData,
    environmentSecretsKey(root, 'local'),
    JSON.stringify({ STAND_PASSWORD: PASSWORD, STAND_TOKEN: TOKEN, SHORT: 'abc' }),
  );
  setStoredKey(appData, environmentSecretsKey(root, 'elsewhere'), '{"FAR_PASSWORD":"far-away-1"}');
  book = createSessionKeyBook(undefined);
  walk = createWalkPort({
    panelAppData: appData,
    keys: book,
    known: (_taskId, sessionId) => book.valuesOf(sessionId, {}),
    driver: { actionTimeoutMs: 2_000 },
  });
});

afterAll(async () => {
  await walk.close();
  await site.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasChromium)('walk tools over a real browser (R1/R2, P177/P178)', () => {
  it('a stand password reaches the page by substitution only — journal, replies and snapshot never hold it', async () => {
    const x = await bench();
    const replies: ModelToolReply[] = [];
    replies.push(await call(x, 'browse_open', { url: `${site.url}/login` }));
    replies.push(
      await call(x, 'browse_fill', {
        target: { label: 'Password' },
        secret: { name: 'STAND_PASSWORD' },
      }),
    );
    const snap = await call(x, 'browse_snapshot', {});
    replies.push(snap);
    replies.push(await call(x, 'browse_click', { target: { role: 'button', name: 'Sign in' } }));
    const hash = await call(x, 'browse_expect', {
      expect: 'text',
      target: { testId: 'hash' },
      value: sha256(PASSWORD),
    });
    replies.push(hash);

    // Значение дошло до стенда: страница напечатала sha256 именно этого пароля.
    expect(hash).toMatchObject({ ok: true, result: { ok: true, n: 5 } });
    // Снимок показал поле пароля — под маской.
    const tree = (snap as { result: { snapshot: string } }).result.snapshot;
    expect(tree).toContain('••••••');
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(PASSWORD);
    for (const file of filesUnder(x.task.dir)) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(PASSWORD);
    }
    const { steps } = rowsOf(x.task);
    expect(steps.map((s) => [s.n, s.action])).toEqual([
      [1, 'open'],
      [2, 'fill'],
      [3, 'snapshot'],
      [4, 'click'],
      [5, 'expect'],
    ]);
    expect(steps[0]).toMatchObject({ value: `${site.url}/login`, url: `${site.url}/login` });
    expect(steps[1]).toMatchObject({ secret: { name: 'STAND_PASSWORD' }, ok: true });
    expect(steps[1]!.value).toBeUndefined();
    expect(steps[3]).toMatchObject({ url: `${site.url}/welcome`, checks: { stale: false } });
    // Маска сессии знает значение: остальные выходы к модели (поток, отчёт) прячут его тоже.
    expect(book.valuesOf(x.b.sessionId, {})).toContain(PASSWORD);
  });

  it('a page echoing the typed secret into its console — the finding is masked in the row and the reply', async () => {
    const x = await bench();
    await call(x, 'browse_open', { url: `${site.url}/echo` });
    const filled = await call(x, 'browse_fill', {
      target: { label: 'Token' },
      secret: { name: 'STAND_TOKEN' },
    });
    expect(filled).toMatchObject({ ok: true, result: { checks: { console: 1 } } });
    const problems = (filled as { result: { problems: string[] } }).result.problems;
    expect(problems.join('\n')).toContain('typed ••••••');
    expect(JSON.stringify(filled)).not.toContain(TOKEN);
    expect(JSON.stringify(rowsOf(x.task).steps)).not.toContain(TOKEN);
  });

  it('a secret of another stand, an unknown name or a too-short value is refused; nothing is typed or journaled', async () => {
    const x = await bench();
    await call(x, 'browse_open', { url: `${site.url}/login` });
    const far = await call(x, 'browse_fill', {
      target: { label: 'Password' },
      secret: { name: 'FAR_PASSWORD' },
    });
    expect(far).toMatchObject({ ok: false, code: 'secret-not-for-this-page' });
    expect(JSON.stringify(far)).not.toContain('far-away-1');
    expect(
      await call(x, 'browse_fill', { target: { label: 'Password' }, secret: { name: 'SHORT' } }),
    ).toMatchObject({ ok: false, code: 'secret-unmaskable' });
    expect(rowsOf(x.task).steps.map((s) => s.action)).toEqual(['open']);
    const value = await call(x, 'browse_expect', {
      expect: 'value',
      target: { label: 'Password' },
      value: '',
    });
    expect(value).toMatchObject({ ok: true, result: { ok: true } });
  });

  it('a click that opens a file chooser: the step row, a file-pick gap and an unsupported reply', async () => {
    const x = await bench();
    await call(x, 'browse_open', { url: `${site.url}/upload` });
    const clicked = await call(x, 'browse_click', { target: { role: 'button', name: 'Attach' } });
    expect(clicked).toMatchObject({ ok: false, code: 'unsupported' });
    const { steps, gaps } = rowsOf(x.task);
    expect(steps.map((s) => s.action)).toEqual(['open', 'click']);
    expect(gaps).toEqual([
      expect.objectContaining({
        stepId: x.b.stepId,
        action: 'file-pick',
        target: { role: 'button', name: 'Attach' },
      }),
    ]);
  });

  it('the core checks reach the model: console, failed request, stale', async () => {
    const x = await bench();
    await call(x, 'browse_open', { url: `${site.url}/broken` });
    expect(
      await call(x, 'browse_click', { target: { role: 'button', name: 'Break' } }),
    ).toMatchObject({ ok: true, result: { checks: { console: 1, failed: 1, stale: false } } });
    await call(x, 'browse_open', { url: `${site.url}/inert` });
    expect(
      await call(x, 'browse_click', { target: { role: 'button', name: 'Nothing' } }),
    ).toMatchObject({ ok: true, result: { checks: { stale: true } } });
  });
});

describe.skipIf(!hasChromium)(
  'walk origin gate: registered stands and loopback only (stage 12, W3-D)',
  () => {
    // Имена `*.test` Chromium этого порта резолвит в 127.0.0.1: `shop.test` — стенд проекта
    // (окружение «Тестов»), `evil.test` — нет; оба на том же стенде-заглушке, без DNS и сети.
    let shopWalk: WalkPort;
    let shopRoot: string;
    let shop: string;
    let evil: string;
    beforeAll(() => {
      const port = new URL(site.url).port;
      shop = `http://shop.test:${port}`;
      evil = `http://evil.test:${port}`;
      shopRoot = temp('walk-shop-');
      mkdirSync(join(shopRoot, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(shopRoot, '.agent', 'tests', 'environments.json'),
        JSON.stringify({
          version: 1,
          environments: [
            { id: 'shop', title: 'shop', baseUrl: `${shop}/app`, secrets: [] },
            { id: 'old', title: 'old', baseUrl: evil, archived: true, secrets: [] },
          ],
        }),
      );
      shopWalk = createWalkPort({
        panelAppData: appData,
        keys: book,
        known: (_taskId, sessionId) => book.valuesOf(sessionId, {}),
        // Срок действия — по умолчанию драйвера (5 с): первое открытие у второго, холодного
        // Chromium однажды не уложилось в 2 с (страница осталась about:blank).
        driver: { args: ['--host-resolver-rules=MAP *.test 127.0.0.1'] },
      });
    });
    afterAll(async () => {
      await shopWalk.close();
    });

    it('a registered stand opens; an unregistered host, an archived stand and a file: URL are refused before the page moves, each a gap row', async () => {
      const x = await bench({ walk: shopWalk, root: shopRoot });
      const first = await call(x, 'browse_open', { url: `${shop}/inert` });
      expect(first, JSON.stringify(first)).toMatchObject({
        ok: true,
        result: { url: `${shop}/inert` },
      });
      for (const url of [`${evil}/inert`, 'file:///C:/Windows/win.ini']) {
        const reply = await call(x, 'browse_open', { url });
        expect(reply).toMatchObject({ ok: false, code: 'origin-not-allowed' });
        expect((reply as { message: string }).message).toMatch(/^origin-not-allowed: /);
      }
      // Страница не двигалась: она там, где её оставило последнее разрешённое открытие.
      expect(shopWalk.driver.urlOf(x.b.sessionId)).toBe(`${shop}/inert`);
      const { steps, gaps } = rowsOf(x.task);
      expect(steps.map((s) => s.url)).toEqual([`${shop}/inert`]);
      expect(gaps.map((g) => [g.action, g.why.split(' ')[0]])).toEqual([
        ['other', 'origin-not-allowed:'],
        ['other', 'origin-not-allowed:'],
      ]);
      expect(gaps[0]!.why).toContain(`${evil} is not a stand of this project`);
      expect(gaps[1]!.why).toContain('file: pages are outside the walk');
    });

    it('a redirect off the stands is the same refusal: the page is reset to about:blank, no step row, no snapshot of the foreign page', async () => {
      const x = await bench({ walk: shopWalk, root: shopRoot });
      const away = `${shop}/away?to=${encodeURIComponent(`${evil}/login`)}`;
      const reply = await call(x, 'browse_open', { url: away });
      expect(reply).toMatchObject({ ok: false, code: 'origin-not-allowed' });
      expect((reply as { message: string }).message).toContain('reset to about:blank');
      expect(shopWalk.driver.urlOf(x.b.sessionId)).toBe('about:blank');
      expect(JSON.stringify(reply)).not.toContain('Password');
      const { steps, gaps } = rowsOf(x.task);
      expect(steps).toEqual([]);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.why).toContain(`${evil} is not a stand of this project`);
      // Петля разрешена и по перенаправлению: стенд на 127.0.0.1 — свой.
      const home = `${shop}/away?to=${encodeURIComponent(`${site.url}/inert`)}`;
      expect(await call(x, 'browse_open', { url: home })).toMatchObject({
        ok: true,
        result: { url: `${site.url}/inert` },
      });
    });

    it("a secret fill queued behind an open of another stand is not typed there: the value reaches only its own stand's origin", async () => {
      // Два стенда проекта, доступ — только у `a.test`. Модель шлёт открытие `b.test` и ввод
      // секрета разом: чтение секрета видит страницу ещё на `a.test`, ввод идёт после открытия.
      const port = new URL(site.url).port;
      const a = `http://a.test:${port}`;
      const bHost = `http://b.test:${port}`;
      const twoRoot = temp('walk-two-');
      mkdirSync(join(twoRoot, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(twoRoot, '.agent', 'tests', 'environments.json'),
        JSON.stringify({
          version: 1,
          environments: [
            { id: 'a', title: 'a', baseUrl: a, secrets: [{ name: 'A_PASSWORD' }] },
            { id: 'b', title: 'b', baseUrl: bHost, secrets: [] },
          ],
        }),
      );
      const aValue = 'a-only-secret-71';
      setStoredKey(
        appData,
        environmentSecretsKey(twoRoot, 'a'),
        JSON.stringify({ A_PASSWORD: aValue }),
      );
      const x = await bench({ walk: shopWalk, root: twoRoot });
      expect(await call(x, 'browse_open', { url: `${a}/login` })).toMatchObject({ ok: true });
      const [opened, filled] = await Promise.all([
        call(x, 'browse_open', { url: `${bHost}/login` }),
        call(x, 'browse_fill', { target: { label: 'Password' }, secret: { name: 'A_PASSWORD' } }),
      ]);
      expect(opened).toMatchObject({ ok: true, result: { url: `${bHost}/login` } });
      expect(filled).toMatchObject({ ok: true, result: { ok: false } });
      expect((filled as { result: { problems: string[] } }).result.problems.join('\n')).toContain(
        'secret-not-for-this-page',
      );
      await call(x, 'browse_click', { target: { role: 'button', name: 'Sign in' } });
      const typed = await call(x, 'browse_expect', {
        expect: 'text',
        target: { testId: 'hash' },
        value: sha256(''),
      });
      // Стенд `b.test` получил пустое поле, а не пароль `a.test`.
      expect(typed).toMatchObject({ ok: true, result: { ok: true } });
      for (const file of filesUnder(x.task.dir))
        expect(readFileSync(file, 'utf8'), file).not.toContain(aValue);
    });

    it('an off-stand redirect or link is stopped before its request is sent: the foreign host gets zero hits', async () => {
      // `evil.test:<порт счётчика>` — чужой хост (не стенд, не петля буквой), за ним — счётчик.
      const counter = await startHitCounter();
      try {
        const foreign = `http://evil.test:${counter.port}/steal?q=data`;
        const x = await bench({ walk: shopWalk, root: shopRoot });
        const away = `${shop}/away?to=${encodeURIComponent(foreign)}`;
        const redirected = await call(x, 'browse_open', { url: away });
        expect(redirected).toMatchObject({ ok: false, code: 'origin-not-allowed' });
        expect((redirected as { message: string }).message).toContain('reset to about:blank');
        expect(counter.hits()).toBe(0);
        // Ссылка стенда, по которой кликнула модель, — та же ворота до отправки.
        const opened = await call(x, 'browse_open', {
          url: `${shop}/link?to=${encodeURIComponent(foreign)}`,
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        const clicked = await call(x, 'browse_click', { target: { role: 'link', name: 'Go' } });
        expect(clicked).toMatchObject({ ok: false, code: 'origin-not-allowed' });
        expect(counter.hits()).toBe(0);
        expect(shopWalk.driver.urlOf(x.b.sessionId)).toBe('about:blank');
        const { steps, gaps } = rowsOf(x.task);
        expect(steps.map((s) => s.action)).toEqual(['open']);
        expect(gaps.map((g) => g.why.split(' ')[0])).toEqual([
          'origin-not-allowed:',
          'origin-not-allowed:',
        ]);
        expect(gaps[0]!.why).toContain(`http://evil.test:${counter.port} is not a stand`);
        // Ресурсы разрешённой страницы грузятся как прежде: стенд открывается и после отказа.
        expect(await call(x, 'browse_open', { url: `${shop}/broken` })).toMatchObject({ ok: true });
        expect(
          await call(x, 'browse_click', { target: { role: 'button', name: 'Break' } }),
        ).toMatchObject({ ok: true, result: { checks: { failed: 1 } } });
      } finally {
        await counter.close();
      }
    });

    it('a stand link or script opening a new window sends nothing: the walk sees one page, the foreign host gets zero hits', async () => {
      const counter = await startHitCounter();
      try {
        const foreign = `http://evil.test:${counter.port}/pop?q=data`;
        const x = await bench({ walk: shopWalk, root: shopRoot });
        const popup = `${shop}/popup?to=${encodeURIComponent(foreign)}`;
        expect(await call(x, 'browse_open', { url: popup })).toMatchObject({ ok: true });
        await call(x, 'browse_click', { target: { role: 'link', name: 'Pop' } });
        await call(x, 'browse_click', { target: { role: 'button', name: 'Window' } });
        await new Promise((done) => setTimeout(done, 500));
        expect(counter.hits()).toBe(0);
        expect(shopWalk.driver.urlOf(x.b.sessionId)).toBe(popup);
      } finally {
        await counter.close();
      }
    });
  },
);

describe('walk tools without a page (P177)', () => {
  it('browse_gesture writes a gap and refuses unsupported — with or without a browser', async () => {
    for (const w of [undefined, null] as const) {
      const x = await bench({ walk: w });
      const reply = await call(x, 'browse_gesture', {
        action: 'hover',
        target: { text: 'Menu' },
        why: 'the menu opens on hover',
      });
      expect(reply).toMatchObject({ ok: false, code: 'unsupported' });
      expect(rowsOf(x.task).gaps).toEqual([
        {
          stepId: x.b.stepId,
          action: 'hover',
          target: { text: 'Menu' },
          why: 'the menu opens on hover',
        },
      ]);
    }
  });

  it('no walk port — not-wired; a CSS target — invalid; a step that is not running — refused', async () => {
    const bare = await bench({ walk: null });
    expect(await call(bare, 'browse_open', { url: 'http://127.0.0.1:9/' })).toMatchObject({
      ok: false,
      code: WALK_NOT_WIRED,
    });
    const x = await bench();
    expect(await call(x, 'browse_click', { target: { css: '#b' } })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const gone = { ...x, b: { ...x.b, stepId: newId() } };
    expect(await call(gone, 'browse_open', { url: 'http://127.0.0.1:9/' })).toMatchObject({
      ok: false,
      code: 'step-not-running',
    });
    expect(rowsOf(x.task).steps).toEqual([]);
  });

  it('a walk tool is not in the plan of another step kind', async () => {
    const x = await bench();
    const work = { ...x, b: { ...x.b, stepKind: 'work' } };
    expect(await call(work, 'browse_open', { url: 'http://127.0.0.1:9/' })).toMatchObject({
      ok: false,
      code: 'tool-not-in-plan',
    });
  });
});
