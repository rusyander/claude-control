import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import {
  mapQwenPermission,
  qwenDenyRules,
  qwenPathPattern,
  qwenSharePatterns,
} from './permission.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planQwen as planWithLayer, qwenHookCommand, qwenPermitReply, refuseQwen } from './qwen.ts';

/** План доверенного репозитория — слой как просили; недоверенная копия (F-86) — своими случаями. */
const planQwen = (spec: SessionSpec, binding: Parameters<typeof planWithLayer>[1]) =>
  planWithLayer(spec, binding, trustedLayer(spec));

/** core-s2: переходник Qwen — F-10, F-13, F-14, F-39, F-41, V5 (по коду переходника и судьи). */

const HOME = homeDir();
const CORE_HOME = join(HOME, '.agentdeck-core-qwen-test');
const COPY = join(HOME, 'work', 'copy');

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(COPY, '..', 'session'),
    cwd: COPY,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: CORE_HOME, tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    ...over,
  };
}

const ctx = (copyRoot: string): PermitContext => ({
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [CORE_HOME],
  endpointSources: [],
  grantRequired: [],
  grants: [],
});

const judge = (tool: string, input: Record<string, unknown>, copyRoot = COPY) =>
  decidePermit(mapQwenPermission({ tool, input }), ctx(copyRoot)).allow;

describe('qwen adapter: core-s2 fixes', () => {
  it('F-10 a session without the core hook is refused; only the conformance flag lets it run', () => {
    const { coreHook: _, ...unhooked } = spec();
    expect(refuseQwen(unhooked)).toMatch(/no core hook/);
    expect(refuseQwen(unhooked, { unhookedForTests: true })).toBeNull();
    expect(refuseQwen(spec())).toBeNull();
  });

  it('F-13 search tools hand the judge the search ROOT: a root above the core home is denied', () => {
    // grep без path ищет в cwd: cwd = дом человека — предок дома ядра.
    expect(judge('grep_search', { pattern: 'token' }, HOME)).toBe(false);
    // glob: маска поднимает корень над path.
    expect(judge('glob', { path: 'src', pattern: '../../../**/token' })).toBe(false);
    expect(judge('grep_search', { pattern: 'x', path: 'src', glob: '../../../**' })).toBe(false);
    expect(judge('list_directory', { path: HOME })).toBe(false);
    // Внутри копии — разрешено.
    expect(judge('grep_search', { pattern: 'token' })).toBe(true);
    expect(judge('glob', { path: 'src', pattern: '**/*.ts' })).toBe(true);
    expect(mapQwenPermission({ tool: 'grep_search', input: { pattern: 'p' } }).target).toBe('.');
  });

  it('F-13 the CLI rules deny every ancestor of the core home as a search root', () => {
    const plan = planQwen(spec(), null);
    const deny = JSON.parse(plan.files['qwen/system-settings.json']!).permissions.deny as string[];
    expect(deny).toContain(`read_file(${qwenPathPattern(COPY, HOME)})`);
    expect(deny).toContain(`read_file(${qwenPathPattern(COPY, join(HOME, '..'))})`);
    expect(deny).not.toContain('read_file(.)');
  });

  it('F-14 the brief and the model are one `--flag=value` word; dash-led ids and names are refused', () => {
    const plan = planQwen(spec({ brief: '- y do it', model: '-m' }), null);
    expect(plan.args).toContain('--append-system-prompt=- y do it');
    expect(plan.args).not.toContain('- y do it');
    expect(plan.args).toContain('--model=-m');
    expect(refuseQwen(spec({ resume: { conversationId: '-y' } }))).toMatch(/resume id/);
    expect(refuseQwen(spec({ mcpServers: { '--yolo': { command: 'node', args: [] } } }))).toMatch(
      /starts with "-"/,
    );
  });

  it('F-39 a deny path or cwd with a glob metacharacter is not written as a rule', () => {
    expect(qwenPathPattern(COPY, join(COPY, 'a[1]'))).toBeNull();
    expect(qwenPathPattern(join(HOME, 'R(D)'), join(HOME, 'x'))).toBeNull();
    const rules = qwenDenyRules(
      { paths: [join(COPY, 'sec{r}et')], commands: [], mcpTools: [], tools: [] },
      COPY,
    );
    expect(rules.unexpressed).toEqual([join(COPY, 'sec{r}et')]);
    expect(rules.rules).toEqual([]);
  });

  it('F-41 a hook word with a shell metacharacter cannot be expressed', () => {
    for (const bad of [
      'node C:/R&D/hook.mjs',
      'node a|b',
      'node %X%',
      'node a^b',
      'node ~/h.mjs',
    ]) {
      expect(qwenHookCommand(bad), bad).toBeNull();
    }
    expect(qwenHookCommand('node C:/Users/RUSYAN~1/Рабочий/hook.mjs core')).toBe(
      'node C:/Users/RUSYAN~1/Рабочий/hook.mjs core',
    );
    expect(refuseQwen(spec({ coreHook: 'node C:/R&D/hook.mjs' }))).toMatch(/metacharacter/);
  });

  it('F-02 a shell line the parser may misread is marked inexact for the judge', () => {
    const exact = (command: string): boolean | undefined =>
      mapQwenPermission({ tool: 'run_shell_command', input: { command } }).argvExact;
    for (const command of [
      'gi\\t push',
      'git pu[s]h',
      '$(echo git) push',
      'g^it push',
      '%G% push',
    ]) {
      expect(exact(command), command).toBe(false);
    }
    expect(exact('git push origin main && npm test')).toBe(true);
  });

  it('F-126 the admin share of this machine gets its own rule for every denied drive path', () => {
    const drive = 'C:\\Users\\me\\.agentdeck';
    const shares = qwenSharePatterns(drive);
    expect(shares).toContain(
      '///[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]/[Cc]$/[Uu][Ss][Ee][Rr][Ss]/[Mm][Ee]/.[Aa][Gg][Ee][Nn][Tt][Dd][Ee][Cc][Kk]',
    );
    expect(shares).toContain(
      '///127.0.0.1/[Cc]$/[Uu][Ss][Ee][Rr][Ss]/[Mm][Ee]/.[Aa][Gg][Ee][Nn][Tt][Dd][Ee][Cc][Kk]',
    );
    expect(qwenSharePatterns('/home/me/.agentdeck')).toEqual([]);
    expect(qwenSharePatterns('C:\\x\\a[1]')).toEqual([]);
    const { rules } = qwenDenyRules(
      { paths: [drive], commands: [], mcpTools: [], tools: [], editPaths: ['C:\\w\\copy\\.qwen'] },
      'C:\\w\\copy',
    );
    for (const share of shares) {
      expect(rules).toEqual(expect.arrayContaining([`read_file(${share})`, `edit(${share}/**)`]));
    }
    expect(rules).toContain(`edit(///127.0.0.1/[Cc]$/[Ww]/[Cc][Oo][Pp][Yy]/.[Qq][Ww][Ee][Nn]/**)`);
  });

  it('V5 a permit reply the CLI could not act on becomes a deny', () => {
    const deny = { behavior: 'deny', message: expect.any(String) };
    expect(qwenPermitReply(undefined)).toEqual(deny);
    expect(qwenPermitReply({ behavior: 'allow' })).toEqual(deny);
    expect(qwenPermitReply('allow')).toEqual(deny);
    const allow = { behavior: 'allow', updatedInput: { a: 1 } };
    expect(qwenPermitReply(allow)).toBe(allow);
  });
});
