import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KIT_HOOKS_DIR } from '../chat/group-profile/group-profile.ts';

/**
 * Группа в режиме набора «глобальные» исполняет только `~/.claude/hooks/**`: правила звеньев
 * (один полный гейт группы — в доставке) жили лишь в копии набора, и группа №1 24.10 прогнала
 * 21 полный гейт (~84 мин). Глобальный хук отдаёт решение копии набора из каталога, который
 * панель кладёт в окружение группы. Проверяется НАСТОЯЩИЙ глобальный диспетчер со stdin, как
 * его зовёт CLI; домашний каталог подменён на временный — свои отметки хуки пишут туда.
 * На машине без глобального слоя (CI) проверять нечего — пропуск.
 */

const DISPATCH = join(homedir(), '.claude', 'hooks', 'pre-tool-dispatch.mjs');
const dir = mkdtempSync(join(tmpdir(), 'gate-global-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const prompt = (text: string) => ({
  type: 'user',
  timestamp: at(-120_000),
  message: { role: 'user', content: text },
});
const use = (name: string, input: Record<string, unknown>, id: string) => ({
  type: 'assistant',
  timestamp: at(-60_000),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string) => ({
  type: 'user',
  timestamp: at(-59_000),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

function pre(
  command: string,
  records: object[],
  env: NodeJS.ProcessEnv,
  extra: Record<string, unknown> = {},
): { decision?: string; reason: string; status: number | null } {
  const out = spawnSync(process.execPath, [DISPATCH], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, ...extra },
      tool_use_id: `u${++n}`,
      session_id: `gate-global-${n}`,
      cwd: dir,
      transcript_path: transcript(records),
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_GROUP_DELIVER_AHEAD: '',
      AGENTDECK_KIT_HOOKS_DIR: '',
      ...env,
    },
    timeout: 20_000,
  });
  const text = out.stdout.trim();
  const parsed = text
    ? (JSON.parse(text) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      })
    : {};
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision,
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
    status: out.status,
  };
}

const FE = 'node scripts/check_frontend.mjs > .agent/tmp/g.log 2>&1';
const TESTS = 'node scripts/check_frontend_tests.mjs > .agent/tmp/g.log 2>&1';
const WORK = {
  AGENTDECK_GROUP_STAGE: 'implement',
  AGENTDECK_GROUP_DELIVER_AHEAD: '1',
  AGENTDECK_KIT_HOOKS_DIR: KIT_HOOKS_DIR,
};

describe.runIf(existsSync(DISPATCH))('глобальный gate-at-end отдаёт звено группы набору', () => {
  it('звено работы с доставкой впереди: гейты проекта — отказ набора, узкий check_i18n — нет', () => {
    for (const command of [FE, TESTS]) {
      const verdict = pre(command, [prompt('сделай')], WORK);
      expect(verdict.decision, command).toBe('deny');
      expect(verdict.reason, command).toContain('a delivery stage follows it');
    }
    expect(pre('node scripts/check_i18n.mjs', [prompt('сделай')], WORK).decision).toBeUndefined();
  });

  it('доставка: красный гейт → правка → полный гейт — отказ до узкой зелёной проверки', () => {
    // Очередь тяжёлых прогонов = группа: её гейт идёт на переднем плане.
    const deliver = {
      AGENTDECK_GROUP_STAGE: 'deliver',
      AGENTDECK_KIT_HOOKS_DIR: KIT_HOOKS_DIR,
      AGENTDECK_HEAVY_QUEUE_DIR: dir,
    };
    const fixed = [
      prompt('доставь'),
      use('Bash', { command: FE }, 'r1'),
      result('r1', 'Exit code 1\n✖ 2 problems'),
      use('Edit', { file_path: 'src/a.ts' }, 'e1'),
      result('e1', 'ok'),
    ];
    const denied = pre(FE, fixed, deliver);
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('pass narrowly on the fixed code');
    const narrowed = [
      ...fixed,
      use('Bash', { command: 'cd inst-chat-ui && npx eslint src/a.ts' }, 'n1'),
      result('n1', 'ok'),
    ];
    expect(pre(FE, narrowed, deliver).decision).toBeUndefined();
  });

  it('без звена и без каталога набора — правила сессии: фоновый гейт идёт, падения нет', () => {
    // Вне группы гейт проекта виден и глобальному классификатору: на переднем плане — отказ.
    const solo = pre(FE, [prompt('сделай')], {});
    expect(solo.decision).toBe('deny');
    expect(solo.reason).toContain('run_in_background:true');
    expect(pre(FE, [prompt('сделай')], {}, { run_in_background: true }).decision).toBeUndefined();
    // Звено есть, каталога набора нет или он неверный: прежние правила сессии, код выхода 0.
    for (const kit of ['', join(dir, 'no-such-kit')]) {
      const lost = pre(
        FE,
        [prompt('сделай')],
        { ...WORK, AGENTDECK_KIT_HOOKS_DIR: kit },
        {
          run_in_background: true,
        },
      );
      expect(lost.status, kit).toBe(0);
      expect(lost.decision, kit).toBeUndefined();
    }
  });
});
