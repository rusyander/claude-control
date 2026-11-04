import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Агенты ревью набора идут без вопроса, но не без предела: 100 за сессию, 101-й получает обычный
 * вопрос spawn-cost-guard — страховка от зациклившегося цикла, а не бюджет (40 останавливали пачку
 * ревью пяти MR посреди прогона). Через настоящий вход набора (`lib/run.mjs pre`) с тем stdin,
 * что даёт CLI; счёт сессии засеян до 99, чтобы не гонять сотню процессов.
 */

const RUN = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const PROMPT =
  'Review lane A of the plan.\n\n[return-format] Final return: compressed English, <=10 lines.\n' +
  '[no-subagents] Do not spawn subagents.';
const STATE = mkdtempSync(join(realpathSync(tmpdir()), 'kit-review-spawn-'));
afterAll(() => rmSync(STATE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function spawnReview(session: string, description: string): string {
  const r = spawnSync(process.execPath, [RUN, 'pre'], {
    input: JSON.stringify({
      session_id: session,
      hook_event_name: 'PreToolUse',
      cwd: STATE,
      tool_name: 'Agent',
      tool_input: { description, subagent_type: 'lane-high', prompt: PROMPT },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_STATE: STATE,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_STEP_KIND: '',
      AGENTDECK_KIT_SPAWN_GUARD: '',
      CLAUDE_SPAWN_GUARD: '',
    },
    timeout: 15_000,
  });
  expect(r.status).toBe(0);
  const out = r.stdout.trim();
  return out ? String(JSON.parse(out).hookSpecificOutput.permissionDecision ?? 'allow') : 'allow';
}

describe('агенты ревью набора: предел за сессию', () => {
  it('сотый проходит без вопроса, сто первый спрашивает; другая сессия считает заново', () => {
    const session = 'review-cap-a';
    const counter = join(STATE, 'stamps', `review-spawns-${session.slice(0, 12)}.txt`);
    mkdirSync(join(STATE, 'stamps'), { recursive: true });
    writeFileSync(counter, '99');

    expect(spawnReview(session, 'deep-review r1 lane A')).toBe('allow');
    expect(readFileSync(counter, 'utf8')).toBe('100');
    expect(spawnReview(session, 'deep-review r2 lane B')).toBe('ask');
    // Отказ не засчитывается: счёт остаётся на пределе, а не растёт дальше.
    expect(readFileSync(counter, 'utf8')).toBe('100');

    expect(spawnReview('review-cap-b', 'deep-review verify prove-1')).toBe('allow');
  });
});
