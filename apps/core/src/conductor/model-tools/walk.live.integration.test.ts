import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowseGap, BrowseStep } from '@agentdeck/contracts/core/browse';
import { environmentSecretsKey } from '@agentdeck/keys/environment-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import {
  chromiumAvailable,
  NO_CHROMIUM_REASON,
} from '../../adapters/browser/__fixtures__/chromium.ts';
import {
  sha256,
  startStandSite,
  type StandSite,
} from '../../adapters/browser/__fixtures__/stand-site.ts';
import { PANEL_DATA_ENV } from '../../bootstrap/panel-profiles.ts';
import {
  configFor,
  hasCli,
  journalOf,
  jsonLines,
  makeStand,
  runCore,
  sweepStand,
  type Stand,
} from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { BASE_REPO, REQ_1 } from '../../stub-tasks/__fixtures__/library/happy-path.ts';
import type { StubTask } from '../../stub-tasks/__fixtures__/stub-tasks.types.ts';

/**
 * Проход по стенду на НАСТОЯЩЕМ `claude` (R1/R2, P177/P178): модель — заглушка ядра
 * (`packages/stub-model`), ядро — отдельный процесс с одноразовым домом, браузер — настоящий
 * Chromium над своим стендом на 127.0.0.1. Модель просит ввести доступ стенда по имени; ядро
 * подставляет значение из хранилища панели (временный каталог, `AGENTDECK_PANEL_DATA`). Стенд
 * печатает sha256 введённого — sha доходит до модели, а сам пароль не лежит ни в одном файле
 * стенда: ни в журнале ядра, ни в следе заглушки (тела запросов модели), ни в стенограмме CLI.
 * Нет CLI или Chromium — прогон пропускается и называет причину.
 */

const present = hasCli(claudeRunFacts.binary.command);
const browser = await chromiumAvailable();
if (!present) console.warn('walk.live: skipped — claude CLI is not in PATH');
if (!browser) console.warn(`walk.live: skipped — ${NO_CHROMIUM_REASON}`);

/** 6 символов: короче порога маски выходов (8) — прятать обязана маска прохода. */
const PASSWORD = 'Lv9-qa';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Модель просит страницу вне стендов проекта, затем свой стенд: ворота источника (W3-D). */
function offStandTask(siteUrl: string): StubTask {
  const base = walkTask(siteUrl);
  return {
    ...base,
    id: 'walk-off-stand-live',
    summary: 'a walk step asks for a page outside the project stands; the core refuses it',
    moves: [
      { op: 'model-tool', tool: 'browse_open', args: { url: `${OFF_STAND}/?q=collected` } },
      { op: 'model-tool', tool: 'browse_open', args: { url: `${siteUrl}/inert` } },
      {
        op: 'model-tool',
        tool: 'step_done',
        args: {
          stepId: '${stepId}',
          outcome: 'done',
          requirements: [{ id: REQ_1, state: 'n/a', evidence: 'walk only, no code checks' }],
          summary: 'the stand page opens; the foreign page was refused',
        },
      },
      { op: 'text', text: 'Walked.' },
    ],
  };
}

/** Чужой сайт: отказ до перехода, поэтому ни DNS, ни сети не нужно. */
const OFF_STAND = 'https://exfil.example.net';

function walkTask(siteUrl: string): StubTask {
  const environments = {
    version: 1,
    environments: [
      { id: 'local', title: 'local', baseUrl: siteUrl, secrets: [{ name: 'STAND_PASSWORD' }] },
    ],
  };
  return {
    id: 'walk-secret-live',
    summary: 'a walk step logs in with a stand secret by name; the value never leaves the browser',
    adversarial: false,
    input: {
      title: 'Walk the login',
      request: 'Log in to the stand and check the welcome page.',
      repo: {
        ...BASE_REPO,
        files: {
          ...BASE_REPO.files,
          '.agent/tests/environments.json': `${JSON.stringify(environments)}\n`,
        },
      },
      stepKind: 'walk',
      requirements: [{ id: REQ_1, text: 'the login works' }],
    },
    moves: [
      { op: 'model-tool', tool: 'browse_open', args: { url: `${siteUrl}/login` } },
      {
        op: 'model-tool',
        tool: 'browse_fill',
        args: { target: { label: 'Password' }, secret: { name: 'STAND_PASSWORD' } },
      },
      { op: 'model-tool', tool: 'browse_snapshot', args: {} },
      {
        op: 'model-tool',
        tool: 'browse_click',
        args: { target: { role: 'button', name: 'Sign in' } },
      },
      { op: 'model-tool', tool: 'browse_snapshot', args: {} },
      {
        op: 'model-tool',
        tool: 'step_done',
        args: {
          stepId: '${stepId}',
          outcome: 'done',
          requirements: [{ id: REQ_1, state: 'n/a', evidence: 'walk only, no code checks' }],
          summary: 'logged in, the welcome page shows',
        },
      },
      { op: 'text', text: 'Walked.' },
    ],
    dialects: ['anthropic-messages'],
    verdicts: [],
    observer: { signals: [] },
    phase2: [],
  };
}

let site: StandSite;
let appData: string;
const before = process.env[PANEL_DATA_ENV];
const stands: Stand[] = [];

beforeAll(async () => {
  site = await startStandSite();
  appData = mkdtempSync(join(tmpdir(), 'walk-live-app-'));
  // Процесс ядра наследует окружение теста: доступы стенда — из этого временного хранилища.
  process.env[PANEL_DATA_ENV] = appData;
});

afterAll(async () => {
  for (const s of stands) await sweepStand(s);
  if (before === undefined) delete process.env[PANEL_DATA_ENV];
  else process.env[PANEL_DATA_ENV] = before;
  await site?.close();
  rmSync(appData, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!present || !browser)('walk step on the real claude CLI (R1/R2, P177/P178)', () => {
  it('the secret reaches the stand by substitution only; journal, model trace and CLI files never hold it', async () => {
    const s = makeStand(walkTask(site.url), 'e2e-walk-');
    stands.push(s);
    setStoredKey(
      appData,
      environmentSecretsKey(s.repo, 'local'),
      JSON.stringify({ STAND_PASSWORD: PASSWORD }),
    );
    const run = await runCore(s, configFor(s, 'claude', 'claimed', { tools: 'by-step' }));
    expect(run.code, run.stderr.slice(-3000)).toBe(0);
    expect(run.result?.outcome, JSON.stringify(run.notes)).toBe('claimed');
    const taskId = run.result!.taskId;

    const steps = journalOf(s, taskId)
      .filter((l) => l.kind === 'browse.step')
      .map((l) => l.data as BrowseStep);
    expect(steps.map((x) => [x.n, x.action, x.ok])).toEqual([
      [1, 'open', true],
      [2, 'fill', true],
      [3, 'snapshot', true],
      [4, 'click', true],
      [5, 'snapshot', true],
    ]);
    expect(steps[1]).toMatchObject({ secret: { name: 'STAND_PASSWORD' } });
    expect(steps[1]!.value).toBeUndefined();
    expect(steps[3]!.url).toBe(`${site.url}/welcome`);

    // Модель: инструменты прохода есть, правки и оболочки нет; sha пароля дошёл, сам пароль — нет.
    const requests = jsonLines(s.trace).filter((r) => r.kind === 'model');
    const bodies = requests.map((r) => JSON.stringify(r.body ?? {}));
    const declared = requests.flatMap((r) =>
      ((r.body as { tools?: { name?: string }[] } | undefined)?.tools ?? []).map((t) =>
        String(t.name),
      ),
    );
    expect(declared.some((n) => n.endsWith('browse_fill'))).toBe(true);
    for (const denied of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
      expect(declared, denied).not.toContain(denied);
    expect(bodies.some((b) => b.includes(sha256(PASSWORD)))).toBe(true);
    expect(bodies.some((b) => b.includes('••••••'))).toBe(true);

    const leaks = filesUnder(s.root).filter((file) => readFileSync(file).includes(PASSWORD));
    expect(leaks).toEqual([]);
  }, 300_000);

  it('a page outside the project stands is refused origin-not-allowed: a gap row, no step row, the model sees the refusal', async () => {
    const s = makeStand(offStandTask(site.url), 'e2e-walk-off-');
    stands.push(s);
    const run = await runCore(s, configFor(s, 'claude', 'claimed', { tools: 'by-step' }));
    expect(run.code, run.stderr.slice(-3000)).toBe(0);
    expect(run.result?.outcome, JSON.stringify(run.notes)).toBe('claimed');
    const lines = journalOf(s, run.result!.taskId);
    const steps = lines.filter((l) => l.kind === 'browse.step').map((l) => l.data as BrowseStep);
    expect(steps.map((x) => [x.n, x.action, x.url])).toEqual([[1, 'open', `${site.url}/inert`]]);
    const gaps = lines.filter((l) => l.kind === 'browse.gap').map((l) => l.data as BrowseGap);
    expect(gaps.map((g) => g.action)).toEqual(['other']);
    expect(gaps[0]!.why).toBe(
      `origin-not-allowed: ${OFF_STAND} is not a stand of this project (no environment in Tests > Environments has this base URL) and not loopback`,
    );
    // Отказ дошёл до модели: следующий запрос несёт результат инструмента с кодом отказа.
    const bodies = jsonLines(s.trace)
      .filter((r) => r.kind === 'model')
      .map((r) => JSON.stringify(r.body ?? {}));
    expect(bodies.some((b) => b.includes('origin-not-allowed'))).toBe(true);
  }, 300_000);
});
