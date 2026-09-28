/**
 * Данные одноразовой панели для кадров телефона (`phone-device.mjs`): два
 * проекта, разговоры с `usage` для аналитики, неотвеченный вопрос агента,
 * кейсы тестов с одним прогоном и фальшивый `claude`, у которого ход «работает».
 *
 * Всё выдумано и не привязано ни к чьему проекту: имена папок, реплики и кейсы
 * — такие, какие бывают у любого веб-приложения. Путь проектов нейтральный
 * (`<диск>/demo/…`), а не временный каталог: временный лежит в
 * профиле пользователя, и его имя встало бы в кадр вкладки «Проекты».
 */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/** Каталог транскриптов проекта так, как его называет CLI. */
const transcriptDir = (cfg, cwd) => join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

export const ASK_SESSION = '3f1c9a52-7d44-4e0b-9a61-5b2e8c0d7a13';
const DONE_SESSION = '8b7e2d10-1c3a-4f5e-8d9c-2a4b6c8e0f21';
const DOCS_SESSION = 'c4d5e6f7-0a1b-4c2d-8e3f-9a0b1c2d3e4f';

const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];

/** Предсказуемый генератор: кадры от прогона к прогону не пляшут. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const usage = (random) => ({
  input_tokens: 200 + Math.floor(random() * 1200),
  output_tokens: 300 + Math.floor(random() * 2200),
  cache_read_input_tokens: 20_000 + Math.floor(random() * 140_000),
  cache_creation_input_tokens: 1500 + Math.floor(random() * 20_000),
});

function writeSession(cfg, project, sessionId, lines, ageMs) {
  const dir = transcriptDir(cfg, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const base = { sessionId, cwd: project };
  writeFileSync(
    file,
    `${lines.map((line) => JSON.stringify({ ...base, ...line })).join('\n')}\n`,
    'utf8',
  );
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}

const assistant = (uuid, at, content, random, model = MODELS[0]) => ({
  type: 'assistant',
  uuid,
  timestamp: at,
  requestId: `req-${uuid}`,
  message: { id: `msg-${uuid}`, role: 'assistant', model, content, usage: usage(random) },
});
const user = (uuid, at, content) => ({
  type: 'user',
  uuid,
  timestamp: at,
  message: { role: 'user', content },
});

/** Разговор, где агент спросил и ждёт ответа (вопрос отказан брокером, как в панели). */
function askSession(cfg, project, random) {
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  writeSession(
    cfg,
    project,
    ASK_SESSION,
    [
      user('u1', at(600_000), 'Add sign-in by QR code to the mobile layout'),
      assistant(
        'a1',
        at(560_000),
        [
          { type: 'text', text: 'Reading the current sign-in form first.' },
          {
            type: 'tool_use',
            id: 'toolu_r1',
            name: 'Read',
            input: { file_path: 'src/auth/SignIn.tsx' },
          },
        ],
        random,
      ),
      user('u2', at(555_000), [
        { type: 'tool_result', tool_use_id: 'toolu_r1', content: 'export function SignIn() {…}' },
      ]),
      assistant(
        'a2',
        at(500_000),
        [
          {
            type: 'tool_use',
            id: 'toolu_ask',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which sign-in stays the default?',
                  header: 'Default',
                  multiSelect: false,
                  options: [
                    { label: 'QR code', description: 'Camera opens first' },
                    { label: 'Email and password', description: 'QR is a secondary button' },
                  ],
                },
              ],
            },
          },
        ],
        random,
      ),
      user('u3', at(499_000), [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_ask',
          is_error: true,
          content: 'The answer comes as the next message.',
        },
      ]),
      assistant('a3', at(498_000), [{ type: 'text', text: 'Waiting for your answer.' }], random),
    ],
    498_000,
  );
}

/** Законченный разговор — с ответом агента и вызовами инструментов. */
function doneSession(cfg, project, sessionId, prompt, reply, ageMs, random, model) {
  const at = (ms) => new Date(Date.now() - ageMs - ms).toISOString();
  writeSession(
    cfg,
    project,
    sessionId,
    [
      user('u1', at(900_000), prompt),
      assistant(
        'a1',
        at(840_000),
        [
          { type: 'text', text: 'Running the tests first.' },
          { type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'npm test' } },
        ],
        random,
        model,
      ),
      user('u2', at(830_000), [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'ok' }]),
      assistant('a2', at(0), [{ type: 'text', text: reply }], random, model),
    ],
    ageMs,
  );
}

/** Прошлые дни — чтобы в аналитике был ряд по дням, а не одна точка. */
function history(cfg, projects, random) {
  for (let day = 13; day >= 1; day -= 1) {
    const project = projects[day % 3 === 0 ? 1 : 0];
    const lines = [];
    const responses = 4 + Math.floor(random() * 6);
    for (let n = 0; n < responses; n += 1) {
      const at = new Date(Date.now() - day * 86_400_000 - n * 300_000).toISOString();
      lines.push(
        assistant(
          `h${day}-${n}`,
          at,
          [{ type: 'text', text: 'Done.' }],
          random,
          MODELS[Math.floor(random() * MODELS.length)],
        ),
      );
    }
    const id = `00000000-0000-4000-8000-${String(day).padStart(12, '0')}`;
    writeSession(cfg, project, id, lines, day * 86_400_000);
  }
}

/** Кейсы проекта: две группы и один записанный прогон — статусы в списке. */
function tests(project) {
  const dir = join(project, '.agent', 'tests');
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const step = (action, expected) => ({ action, expected });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const statuses = {
    'auth-001': 'passed',
    'auth-002': 'failed',
    'auth-003': 'passed',
    'checkout-001': 'passed',
    'checkout-002': 'passed',
  };
  const runId = '20260928080000-5ea1c0de';
  const kase = (id, title, priority) => ({
    id,
    type: 'case',
    title,
    priority,
    readiness: 'ready',
    steps: [step('Open the screen', 'The screen opens without errors')],
    expected: 'Works as described.',
    // Статус кейса живёт в самом кейсе: его и показывает список, а запись
    // прогона ниже — история, на которую он ссылается.
    status: statuses[id],
    lastRunAt: at,
    lastRunId: runId,
  });
  const groups = {
    auth: {
      title: 'Sign-in',
      cases: [
        kase('auth-001', 'Sign in with email and password', 'high'),
        kase('auth-002', 'Sign in by QR code', 'high'),
        kase('auth-003', 'Wrong password shows a message', 'medium'),
      ],
    },
    checkout: {
      title: 'Checkout',
      cases: [
        kase('checkout-001', 'Cart total updates after removing an item', 'high'),
        kase('checkout-002', 'Promo code is applied once', 'medium'),
      ],
    },
  };
  for (const [id, group] of Object.entries(groups)) {
    writeFileSync(
      join(dir, `${id}.tests.json`),
      `${JSON.stringify({ version: 1, title: group.title, cases: group.cases }, null, 2)}\n`,
      'utf8',
    );
  }
  const results = Object.entries(statuses).map(([caseId, status]) => {
    const groupId = caseId.split('-')[0];
    return {
      pointId: `${groupId}|${caseId}`,
      groupId,
      caseId,
      status,
      startedAt: at,
      finishedAt: at,
      durationMs: 4000,
    };
  });
  writeFileSync(
    join(dir, 'runs', `${runId}.run.json`),
    `${JSON.stringify(
      {
        id: runId,
        mode: 'import',
        actor: 'ci',
        origin: 'e2e',
        status: 'done',
        exitCode: 1,
        startedAt: at,
        finishedAt: at,
        results,
        summary: { total: 5, passed: 4, failed: 1, skipped: 0, blocked: 0 },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** Разложить всё до старта панели. `projects` — [главный, второй]. */
export function seedPhoneDemo(cfg, projects) {
  const random = rng(20260928);
  for (const project of projects) mkdirSync(project, { recursive: true });
  askSession(cfg, projects[0], random);
  doneSession(
    cfg,
    projects[0],
    DONE_SESSION,
    'Fix the failing cart total test',
    'Fixed: the total now rounds after the discount. All 42 tests pass.',
    3 * 3_600_000,
    random,
    MODELS[1],
  );
  doneSession(
    cfg,
    projects[1],
    DOCS_SESSION,
    'Update the install guide for Node 22',
    'Updated the guide and the version check in the setup script.',
    26 * 3_600_000,
    random,
    MODELS[2],
  );
  history(cfg, projects, random);
  tests(projects[0]);
}

/**
 * Фальшивый `claude`: stream-json, один процесс на разговор. Ход держится до
 * конца съёмки — так на главной есть разговор «работает». Реплики — обычные,
 * без служебных слов проверок: они попадают в кадр справки.
 */
export const PHONE_FAKE_CLI = String.raw`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
const PARENT = process.ppid;
const parentAlive = () => { try { process.kill(PARENT, 0); return true; } catch { return false; } };
setInterval(() => { if (!existsSync(ALIVE) || !parentAlive()) process.exit(0); }, 250).unref();
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write('2.1.0 (Claude Code)\n'); process.exit(0); }
const sid = after('--resume') ?? after('--session-id') ?? crypto.randomUUID();
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
let started = false;
process.stdin.on('data', () => {
  if (started) return;
  started = true;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-4-5', cwd: process.cwd(), tools: [] });
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'Running the checkout tests, this takes a few minutes.' },
      { type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'npm run test:e2e' } }] } });
});
setInterval(() => {}, 60000);
`;
