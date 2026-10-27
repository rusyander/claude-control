import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * N5 (g5 25.10, MR !1101): группе запретили опрос конвейера, и она искала обход —
 * `discover_tools {"category":"merge_requests"}` положил в окно 29 инструментов (слияние,
 * одобрение, удаление заметок), ни один не понадобился, ~5 КБ дельты перечитывались в
 * каждом следующем запросе. Группа включает только категории доставки. Путь настоящий:
 * диспетчер набора `run.mjs pre` отдельным процессом, как его зовёт CLI.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-forge-toolset-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function pre(tool_name: string, tool_input: object, split = true): string {
  const transcript = join(dir, `t${++n}.jsonl`);
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'доведи MR' } })}\n`,
    'utf8',
  );
  const { AGENTDECK_SPLIT_CHILD: _drop, ...env } = process.env;
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      transcript_path: transcript,
      session_id: 'kit-forge-toolset',
      cwd: dir,
    }),
    encoding: 'utf8',
    env: {
      ...env,
      ...(split ? { AGENTDECK_SPLIT_CHILD: '1' } : {}),
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
    },
    timeout: 15_000,
  }).stdout.trim();
  const hook = out
    ? (JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    : {};
  return hook.hookSpecificOutput?.permissionDecisionReason ?? '';
}

describe('N5: forge-toolset-guard — группа включает только категории доставки', () => {
  const DISCOVER = 'mcp__gitlab-work__discover_tools';

  it('категория вне доставки (issues, wiki, api) в группе — отказ с разрешёнными категориями', () => {
    for (const category of ['issues', 'wiki', 'api', 'variables']) {
      const reason = pre(DISCOVER, { category });
      expect(reason).toMatch(/forge-toolset-guard/);
      expect(reason).toContain(`Refused: ${category}`);
      expect(reason).toContain('merge_requests, pipelines');
    }
  });

  it('список через запятую: отказ называет только лишние', () => {
    const reason = pre(DISCOVER, { category: 'pipelines, labels,releases' });
    expect(reason).toContain('Refused: labels, releases');
  });

  it('merge_requests, pipelines и список без категории — проходят', () => {
    expect(pre(DISCOVER, { category: 'merge_requests' })).toBe('');
    expect(pre(DISCOVER, { category: 'pipelines' })).toBe('');
    expect(pre(DISCOVER, {})).toBe('');
  });

  it('форма opencode (<server>_discover_tools) судится так же', () => {
    expect(pre('gitlab-work_discover_tools', { category: 'snippets' })).toContain(
      'Refused: snippets',
    );
  });

  it('вне группы разделения хук молчит: человек сам решает, что включать', () => {
    expect(pre(DISCOVER, { category: 'issues' }, false)).toBe('');
  });
});
