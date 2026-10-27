import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Находки наблюдения за группой g9 (25.10, стадия работы), страж `gate-at-end` набора.
 * Команды — дословно из разговора группы, путь копии заменён временным каталогом той же формы.
 *
 * 3: отказ на `check_frontend.mjs` группа обошла руками — `npm --prefix inst-admin-ui run test:ci -- src`,
 *    весь набор пакета (857 файлов, 350 с) в стадии работы перед доставкой. Части гейта — тоже гейт.
 * 6: `npm --prefix D exec -- vitest …` и `npx --prefix D vitest …` стартуют в папке оболочки, конфиг,
 *    setup и псевдонимы D не грузятся — «наборы не загружаются», дважды (18 с + 27 с). Отказ с верной формой.
 * 10: узкие составные команды (`cd shared-ui && npx vitest run <файл> > ../лог; npm run build`,
 *    `npm --prefix inst-admin-ui run type-check`) судились как полный гейт: цель перенаправления читалась
 *    аргументом, `--prefix <пакет>` не считался одним пакетом.
 * Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-g9-scope-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Копия монорепозитория в миниатюре: корень репозитория, пакеты со своим конфигом vitest.
const ROOT = join(dir, 'copy');
for (const pkg of ['inst-admin-ui', 'shared-ui']) {
  mkdirSync(join(ROOT, pkg), { recursive: true });
  writeFileSync(join(ROOT, pkg, 'package.json'), '{}\n');
  writeFileSync(join(ROOT, pkg, 'vitest.config.ts'), 'export default {};\n');
}
mkdirSync(join(ROOT, '.git'));
const FWD = ROOT.replace(/\\/g, '/');
const POSIX = FWD.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

let n = 0;
const prompt = {
  type: 'user',
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'сделай' },
};
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const WORK = {
  AGENTDECK_GROUP_STAGE: 'work',
  AGENTDECK_GROUP_DELIVER_AHEAD: '1',
  AGENTDECK_HEAVY_QUEUE_DIR: dir,
};

function gate(command: string, env: NodeJS.ProcessEnv, records: object[] = [prompt]) {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_use_id: `u${++n}`,
      cwd: ROOT,
      transcript_path: transcript(records),
      session_id: `g9-${n}`,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_GROUP_DELIVER_AHEAD: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  const p = out
    ? ((
        JSON.parse(out) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput ?? {})
    : {};
  return { decision: p.permissionDecision, reason: p.permissionDecisionReason ?? '' };
}

const NARROW_10 = [
  'cd shared-ui && npx vitest run src/components/GuardrailForm/GuardrailForm.test.tsx > ../.agent/tmp-vitest.log 2>&1; echo exit=$?; grep -E "Test Files|Tests |FAIL" ../.agent/tmp-vitest.log | head; npm run build > ../.agent/tmp-build.log 2>&1; echo build=$?; tail -3 ../.agent/tmp-build.log',
  `cd ${FWD}/inst-admin-ui && npx tsc -p tsconfig.app.json --noEmit > ../.agent/tmp-tsc.log 2>&1; echo tsc=$?; grep -c "error TS" ../.agent/tmp-tsc.log; npx vitest run src/pages/knowledge-bases src/features/kb-access-config > ../.agent/tmp-kb.log 2>&1; grep -E "Test Files|Tests |FAIL" ../.agent/tmp-kb.log | head -20`,
  `cd ${POSIX}; npm --prefix inst-admin-ui run test:ci -- src/pages/mcp src/features/mcp > .agent/e5-mcp-tests.log 2>&1; echo exit=$?; npm --prefix inst-admin-ui run type-check > .agent/e5-tsc.log 2>&1; echo tsc=$?; grep "error TS" .agent/e5-tsc.log | head`,
];
const WHOLE_3: [string, string] = [
  `cd ${POSIX} && npm --prefix inst-admin-ui run test:ci -- src > .agent/e6-alltests.log 2>&1; echo exit=$?; grep -E "Test Files|Tests  " .agent/e6-alltests.log`,
  'cd inst-admin-ui && npx vitest run > ../.agent/all.log 2>&1',
];
const PREFIX_6: [string, string] = [
  'npm --prefix inst-admin-ui exec -- vitest run src/pages/users/CreateRolePage src/pages/skills > .agent/tmp-vitest-e7.log 2>&1; echo exit=$?',
  'npx --prefix inst-admin-ui vitest run --root inst-admin-ui src/pages/users/CreateRolePage src/pages/skills > .agent/tmp-vitest-e7.log 2>&1; echo exit=$?',
];

describe('gate-at-end: узкие составные команды не гейт (g9 10)', () => {
  it.each(NARROW_10)('стадия работы, проходит: %s', (command) => {
    expect(gate(command, WORK).decision).toBeUndefined();
  });

  it('узкие формы рядом тоже проходят', () => {
    for (const command of [
      'npm --prefix inst-admin-ui run test:ci -- src/pages/users/CreateRolePage > .agent/e7.log 2>&1',
      'cd inst-admin-ui && npx vitest related src/pages/users/CreateRolePage/index.tsx --run',
      'cd inst-admin-ui && npx vitest run -t "CreateRolePage"',
      'npm --prefix inst-admin-ui exec -- tsc -p tsconfig.app.json --noEmit',
    ])
      expect(gate(command, WORK).decision, command).toBeUndefined();
  });
});

describe('gate-at-end: весь набор руками в стадии работы — тоже гейт (g9 3)', () => {
  it.each(WHOLE_3)('отказ, и повтор его не снимает: %s', (command) => {
    const first = gate(command, WORK);
    expect(first.decision).toBe('deny');
    expect(first.reason).toContain('runs a test suite whole');
    expect(first.reason).toContain('delivery stage');
    const again = gate(command, WORK, [
      prompt,
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r1',
              content: `PreToolUse:Bash hook error: ${first.reason}`,
            },
          ],
        },
      },
    ]);
    expect(again.decision).toBe('deny');
  });

  it('вне стадии работы и без доставки впереди — не трогает', () => {
    expect(gate(WHOLE_3[1], {}).decision).toBeUndefined();
    expect(
      gate(WHOLE_3[1], { AGENTDECK_GROUP_STAGE: 'work', AGENTDECK_HEAVY_QUEUE_DIR: dir }).decision,
    ).toBeUndefined();
    expect(
      gate(WHOLE_3[1], { ...WORK, AGENTDECK_GROUP_STAGE: 'deliver' }).decision,
    ).toBeUndefined();
  });
});

describe('gate-at-end: --prefix у npm exec / npx не меняет папку запуска (g9 6)', () => {
  it.each(PREFIX_6)('отказ с верной формой в любой сессии: %s', (command) => {
    for (const env of [WORK, {}]) {
      const r = gate(command, env);
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('cd inst-admin-ui && npx vitest run <files>');
    }
  });

  it('повтор того же вызова после отказа проходит (оболочка уже в пакете)', () => {
    const command = PREFIX_6[0];
    const first = gate(command, {});
    const again = gate(command, {}, [
      prompt,
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'p1',
              content: `PreToolUse:Bash hook error: ${first.reason}`,
            },
          ],
        },
      },
    ]);
    expect(again.decision).toBeUndefined();
  });

  it('пакет без своего конфига vitest — не отказ; `run <скрипт>` идёт в пакете — не отказ', () => {
    mkdirSync(join(ROOT, 'docs'), { recursive: true });
    expect(gate('npx --prefix docs vitest run a.test.ts', {}).decision).toBeUndefined();
    expect(
      gate('npm --prefix inst-admin-ui run test:ci -- src/pages/users', {}).decision,
    ).toBeUndefined();
  });
});
