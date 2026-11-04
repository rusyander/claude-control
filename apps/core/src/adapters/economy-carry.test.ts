import { describe, expect, it } from 'vitest';
import type { SessionEconomy, SessionSpec } from './adapter.types.ts';
import { planClaude } from './claude/claude.ts';
import { planCodex } from './codex/codex.ts';
import { liveRoot, liveSpec } from './conformance/__fixtures__/live.ts';
import { compactFraction, CODEX_DEFAULT_TOOL_OUTPUT_TOKENS } from './economy-carry.ts';
import { planGemini } from './gemini/gemini.ts';
import { planGoose } from './goose/goose.ts';
import { planKimi } from './kimi/kimi.ts';
import { planOpencode } from './opencode/opencode.ts';
import { planQwen } from './qwen/qwen.ts';
import { trustedLayer } from './sdk-stream/layer-run.ts';

/**
 * Рычаги экономии шага в каждом CLI (s10 p8, порт `economy-run` + `group-profile` панели): план
 * настоящего переходника кладёт рычаг своим ключом CLI (окружение, `--settings`, config.toml,
 * системные настройки) или называет потерю; без рычагов план прежний.
 */

const live = liveRoot('economy-carry-');
const ALL: SessionEconomy = {
  compactWindow: 160_000,
  bashOutputChars: 6_000,
  readOutputTokens: 3_000,
  cacheTtl: '1h',
  detachIde: true,
  workHabits: true,
  modelWindow: 400_000,
};
const specOf = (economy?: SessionEconomy, over: Partial<SessionSpec> = {}): SessionSpec =>
  liveSpec(live, {
    coreHook: '"node" "hook.mjs"',
    ...(economy ? { economy } : {}),
    ...over,
  });
const plan = <T>(
  fn: (s: SessionSpec, b: null, l: ReturnType<typeof trustedLayer>) => T,
  s: SessionSpec,
) => fn(s, null, trustedLayer(s));

describe('economy levers per CLI (s10 p8)', () => {
  it('share of the model window: 4 digits down; unknown window or share ≥ 1 — none', () => {
    expect(compactFraction(160_000, 400_000)).toBe(0.4);
    expect(compactFraction(100_000, 300_000)).toBe(0.3333);
    expect(compactFraction(160_000, undefined)).toBeNull();
    expect(compactFraction(500_000, 400_000)).toBeNull();
  });

  it('claude: window, ide and silent reminder in the process env; read limit, ttl and bash limit in --settings', () => {
    const p = plan(planClaude, specOf(ALL));
    expect(p.env).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
      CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
      CLAUDE_CODE_SILENT_TURN_REMINDER: '0',
    });
    const settings = JSON.parse(p.files['claude/settings.json']!) as Record<string, unknown>;
    expect(settings.bashOutputMaxChars).toBe(6_000);
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '3000',
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    });
    const bare = plan(planClaude, specOf());
    expect(bare.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(JSON.parse(bare.files['claude/settings.json']!)).not.toHaveProperty(
      'bashOutputMaxChars',
    );
  });

  it('codex: top-level config.toml keys BEFORE every table; one tool limit = max(bash/4, read), only below its own 2500', () => {
    const p = plan(planCodex, specOf(ALL));
    const toml =
      p.files['codex/home/config.toml'] ??
      Object.values(p.files).find((t) => t.includes('model_auto_compact'))!;
    expect(toml).toContain('model_auto_compact_token_limit = 160000');
    expect(toml).not.toContain('tool_output_token_limit');
    expect(toml.indexOf('model_auto_compact_token_limit')).toBeLessThan(
      toml.indexOf('[') === -1 ? Infinity : toml.indexOf('['),
    );
    expect(p.layerLosses).toContain('economy cacheTtl: codex has no prompt cache ttl key');
    const small = plan(planCodex, specOf({ bashOutputChars: 4_000, readOutputTokens: 2_000 }));
    const smallToml = Object.values(small.files).find((t) =>
      t.includes('tool_output_token_limit'),
    )!;
    expect(smallToml).toContain(`tool_output_token_limit = ${2_000}`);
    expect(2_000).toBeLessThan(CODEX_DEFAULT_TOOL_OUTPUT_TOKENS);
  });

  it('goose: share of the core-known window + that window, tool response = max(bash, read×4) chars; ttl named', () => {
    const p = plan(planGoose, specOf(ALL));
    expect(p.env).toMatchObject({
      GOOSE_AUTO_COMPACT_THRESHOLD: '0.4',
      GOOSE_CONTEXT_LIMIT: '400000',
      GOOSE_MAX_TOOL_RESPONSE_SIZE: '12000',
    });
    expect(p.layerLosses?.some((l) => l.startsWith('economy cacheTtl'))).toBe(true);
    const blind = plan(planGoose, specOf({ compactWindow: 160_000 }));
    expect(blind.env).not.toHaveProperty('GOOSE_AUTO_COMPACT_THRESHOLD');
    expect(blind.layerLosses).toContain(
      'economy compactWindow: goose takes a share of the model window, and the window is unknown',
    );
  });

  it('qwen: system settings layer — share, one tool limit in chars, ide off; ttl only on an anthropic endpoint', () => {
    const p = plan(planQwen, specOf(ALL));
    const settings = JSON.parse(Object.values(p.files)[0]!) as Record<
      string,
      Record<string, unknown>
    >;
    expect(settings.context).toEqual({ autoCompactThreshold: 0.4 });
    expect(settings.tools).toEqual({ truncateToolOutputThreshold: 12_000 });
    expect(settings.ide).toEqual({ enabled: false });
    expect(p.layerLosses).toContain(
      'economy cacheTtl: qwen reads cacheRetention only on an anthropic endpoint',
    );
  });

  it('kimi: [loop_control] compaction_trigger_ratio clamped to 0.5..0.99 and named; tool limits named', () => {
    const p = plan(planKimi, specOf(ALL));
    const toml = Object.values(p.files)[0]!;
    expect(toml).toContain('[loop_control]\ncompaction_trigger_ratio = 0.5');
    expect(p.layerLosses).toContain(
      'economy compactWindow: kimi accepts a share 0.5..0.99: 0.4 → 0.5',
    );
    expect(p.layerLosses).toContain('economy bashOutputChars: kimi has no tool output limit key');
    const exact = plan(planKimi, specOf({ compactWindow: 300_000, modelWindow: 400_000 }));
    expect(Object.values(exact.files)[0]).toContain('compaction_trigger_ratio = 0.75');
  });

  it('gemini and opencode: every set lever is a named loss; no lever — no loss', () => {
    const g = plan(planGemini, specOf(ALL));
    expect(g.layerLosses?.filter((l) => l.startsWith('economy '))).toHaveLength(4);
    expect(g.layerLosses?.[0]).toMatch(/admin-owned/);
    const o = plan(planOpencode, specOf(ALL));
    expect(o.layerLosses).toContain('economy compactWindow: opencode config has no key for it');
    expect(plan(planOpencode, specOf()).layerLosses).toBeUndefined();
  });
});
