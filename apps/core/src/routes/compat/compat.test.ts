import { describe, expect, it } from 'vitest';
import type {
  AdapterChannelSummary,
  CompatAdapter,
  CompatDecision,
  CompatPolicy,
  CompatRoute,
  ModelFacts,
} from '@agentdeck/contracts/core/routes';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import type { CliRunFacts } from '@agentdeck/providers/types';
import { createCliLoginRoute } from '../cli-login/cli-login.ts';
import { OWN_CAPS } from '../local/own/own.ts';
import { STUB_CAPS } from '../stub/stub.ts';
import { compat } from './compat.ts';

/**
 * Совместимость (11 R:PR-05) данными: каждый из 10 CLI реестра × маршруты фазы 2 (stub, своя
 * модель, свой вход CLI). Возможности переходника берутся из фактов запуска так же, как их
 * отдаст переходник (W2-B): канал файла чужого конфига — `perSession: false`.
 */

function adapterOf(
  facts: CliRunFacts,
  bypassActive: CompatAdapter['bypassActive'] = {},
): CompatAdapter {
  const channels: AdapterChannelSummary[] = facts.channels.map((channel) => ({
    via: channel.via,
    dialect: channel.dialect,
    ...(channel.via !== 'file' && channel.keyVar ? { keyVar: channel.keyVar } : {}),
    ...(channel.via !== 'file' && channel.bypass ? { bypass: { ...channel.bypass } } : {}),
    perSession: channel.via !== 'file',
  }));
  return {
    id: facts.id,
    caps: { login: facts.login, channels, limitsChannel: facts.limitsChannel?.via ?? null },
    bypassActive,
  };
}

const stubRoute: CompatRoute = {
  id: 'stub:any',
  caps: STUB_CAPS,
  availability: { state: 'value', onUnknown: 'retry-until' },
  credential: 'none',
};
const ownRoute: CompatRoute = {
  id: 'local:own',
  caps: OWN_CAPS,
  availability: { state: 'value', onUnknown: 'retry-until' },
  credential: 'none',
};
const loginRoute = (adapter: string): CompatRoute => ({
  id: `cli-login:${adapter}`,
  caps: createCliLoginRoute({ id: adapter }).caps,
  availability: { state: 'unknown', onUnknown: 'run' },
  credential: 'unknown',
});
const model: ModelFacts = { id: 'm-1', served: 'value', contextTokens: 32_000, tools: true };

const basePolicy = (extra: Partial<CompatPolicy> = {}): CompatPolicy => ({
  allowed: [{ adapter: '*', route: '*', modelPattern: '*' }].flatMap(() =>
    CLI_RUN_FACTS.flatMap((f) =>
      [stubRoute.id, ownRoute.id, `cli-login:${f.id}`, 'cli-login:claude'].map((route) => ({
        adapter: f.id,
        route,
        modelPattern: '*',
      })),
    ),
  ),
  dlp: { required: false, parses: ['anthropic-messages', 'openai-chat', 'openai-responses'] },
  translations: [
    { from: 'openai-responses', to: 'openai-chat' },
    { from: 'google-genai', to: 'openai-chat' },
    { from: 'openai-chat', to: 'anthropic-messages' },
    { from: 'anthropic-messages', to: 'openai-chat' },
  ],
  needsTools: false,
  ...extra,
});

/** Короткая подпись решения для таблицы. */
function sig(decision: CompatDecision): string {
  if (decision.kind === 'refused')
    return decision.setting
      ? `refused:${decision.code}:${decision.setting}`
      : `refused:${decision.code}`;
  if (decision.kind === 'via-gateway') return `via-gateway:${decision.from}->${decision.to}`;
  return decision.channel.via === 'login' ? 'direct:login' : `direct:${decision.channel.dialect}`;
}

// Ожидания по фактам (11 R:PR-05): файл чужого конфига → no_channel; неизвестный обход → отказ.
const EXPECTED: Record<string, { stub: string; own: string; login: string; open: string }> = {
  claude: {
    stub: 'direct:anthropic-messages',
    own: 'direct:anthropic-messages',
    login: 'direct:login',
    open: 'direct:anthropic-messages',
  },
  codex: {
    stub: 'refused:no_channel',
    own: 'refused:no_channel',
    login: 'direct:login',
    open: 'refused:no_channel',
  },
  gemini: {
    stub: 'refused:bypass_setting:security.auth.selectedType',
    own: 'refused:bypass_setting:security.auth.selectedType',
    login: 'direct:login',
    open: 'via-gateway:google-genai->openai-chat',
  },
  qwen: {
    stub: 'direct:openai-chat',
    own: 'direct:openai-chat',
    login: 'direct:login',
    open: 'direct:openai-chat',
  },
  continue: {
    stub: 'refused:no_channel',
    own: 'refused:no_channel',
    login: 'direct:login',
    open: 'refused:no_channel',
  },
  goose: {
    stub: 'refused:bypass_setting:GOOSE_LEAD_PROVIDER',
    own: 'refused:bypass_setting:GOOSE_LEAD_PROVIDER',
    login: 'direct:login',
    open: 'direct:openai-chat',
  },
  kimi: {
    stub: 'refused:bypass_setting:[secondary_model] model',
    own: 'refused:bypass_setting:[secondary_model] model',
    login: 'direct:login',
    open: 'direct:openai-chat',
  },
  cursor: {
    stub: 'refused:login_only',
    own: 'refused:login_only',
    login: 'direct:login',
    open: 'refused:login_only',
  },
  opencode: {
    stub: 'direct:openai-chat',
    own: 'refused:window_untellable',
    login: 'direct:login',
    open: 'direct:openai-chat',
  },
  aider: {
    stub: 'direct:openai-chat',
    own: 'refused:window_untellable',
    login: 'direct:login',
    open: 'direct:openai-chat',
  },
};

const allOff = (facts: CliRunFacts): Record<string, boolean> =>
  Object.fromEntries(
    facts.channels.flatMap((c) =>
      c.via !== 'file' && c.bypass ? [[c.bypass.setting, false]] : [],
    ),
  );

describe('R:PR-05 compat — caps, never names, over all 10 CLIs', () => {
  it('R:PR-05 compat table: 10 CLIs × stub / local:own / own cli-login, bypass unknown and bypass off', () => {
    expect(CLI_RUN_FACTS.map((f) => f.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    const got: Record<string, unknown> = {};
    for (const facts of CLI_RUN_FACTS) {
      const adapter = adapterOf(facts);
      got[facts.id] = {
        stub: sig(compat(adapter, stubRoute, model, basePolicy())),
        own: sig(compat(adapter, ownRoute, model, basePolicy())),
        login: sig(compat(adapter, loginRoute(facts.id), model, basePolicy())),
        open: sig(compat(adapterOf(facts, allOff(facts)), stubRoute, model, basePolicy())),
      };
    }
    expect(got).toEqual(EXPECTED);
    // Чужой вход CLI не годится: привязка входа — к одному переходнику.
    const qwen = CLI_RUN_FACTS.find((f) => f.id === 'qwen');
    expect(sig(compat(adapterOf(qwen!), loginRoute('claude'), model, basePolicy()))).toBe(
      'refused:no_channel',
    );
  });

  it('R:PR-05 compat: every refusal code reachable, in its order (set, access, wire, DLP, model, limits)', () => {
    const claude = adapterOf(CLI_RUN_FACTS.find((f) => f.id === 'claude')!);
    const gemini = adapterOf(
      CLI_RUN_FACTS.find((f) => f.id === 'gemini')!,
      { 'security.auth.selectedType': false },
    );
    const p = basePolicy();
    const code = (d: CompatDecision): string => (d.kind === 'refused' ? d.code : d.kind);
    expect(code(compat(claude, stubRoute, model, { ...p, allowed: [] }))).toBe('not_allowed');
    expect(
      code(
        compat(
          claude,
          { ...stubRoute, availability: { state: 'absent', onUnknown: 'run' } },
          model,
          p,
        ),
      ),
    ).toBe('route_unavailable');
    expect(
      code(
        compat(
          claude,
          { ...stubRoute, availability: { state: 'unknown', onUnknown: 'refuse' } },
          model,
          p,
        ),
      ),
    ).toBe('route_unavailable');
    expect(
      code(
        compat(
          claude,
          { ...stubRoute, availability: { state: 'unknown', onUnknown: 'run' } },
          model,
          p,
        ),
      ),
    ).toBe('direct');
    expect(code(compat(claude, { ...stubRoute, credential: 'absent' }, model, p))).toBe(
      'credential_absent',
    );
    expect(code(compat(claude, { ...stubRoute, credential: 'unknown' }, model, p))).toBe('direct');
    expect(code(compat(claude, stubRoute, { ...model, served: 'absent' }, p))).toBe('model_absent');
    const dlp = {
      ...p,
      dlp: { required: true, parses: ['anthropic-messages', 'openai-chat'] as const },
    };
    expect(
      code(
        compat(claude, stubRoute, model, {
          ...dlp,
          dlp: { ...dlp.dlp, parses: [...dlp.dlp.parses] },
        }),
      ),
    ).toBe('direct');
    // Gemini: DLP требуется, тело google не разбирается (11 R:PR-05 «Gemini today»).
    expect(
      code(
        compat(gemini, stubRoute, model, {
          ...p,
          dlp: { required: true, parses: ['openai-chat'] },
        }),
      ),
    ).toBe('dlp_opaque');
    expect(
      code(
        compat(claude, { ...stubRoute, caps: { ...STUB_CAPS, maskable: false } }, model, {
          ...p,
          dlp: { required: true, parses: ['anthropic-messages'] },
        }),
      ),
    ).toBe('dlp_opaque');
    // Вход CLI без привязки — звену DLP негде встать.
    expect(
      code(
        compat(claude, loginRoute('claude'), model, { ...p, dlp: { required: true, parses: [] } }),
      ),
    ).toBe('dlp_opaque');
    expect(
      code(compat(claude, stubRoute, { ...model, tools: false }, { ...p, needsTools: true })),
    ).toBe('no_tools');
    expect(
      code(
        compat(claude, { ...stubRoute, caps: { ...STUB_CAPS, tools: false } }, model, {
          ...p,
          needsTools: true,
        }),
      ),
    ).toBe('no_tools');
    expect(code(compat(claude, stubRoute, model, { ...p, needsTools: true }))).toBe('direct');
    expect(code(compat(claude, stubRoute, model, { ...p, minContextTokens: 64_000 }))).toBe(
      'context_too_small',
    );
    expect(
      code(
        compat(claude, stubRoute, { ...model, contextTokens: undefined } as ModelFacts, {
          ...p,
          minContextTokens: 64_000,
        }),
      ),
    ).toBe('direct');
    expect(code(compat(claude, stubRoute, model, { ...p, minContextTokens: 32_000 }))).toBe(
      'direct',
    );
    const noLimits = { ...claude, caps: { ...claude.caps, limitsChannel: null } };
    expect(code(compat(noLimits, ownRoute, model, p))).toBe('window_untellable');
    // Нет пары перевода — канала нет.
    expect(code(compat(gemini, stubRoute, model, { ...p, translations: [] }))).toBe('no_channel');
    // Обход включён у человека — отказ с именем настройки, даже если канал есть.
    const on = adapterOf(
      CLI_RUN_FACTS.find((f) => f.id === 'gemini')!,
      { 'security.auth.selectedType': true },
    );
    expect(compat(on, stubRoute, model, p)).toMatchObject({
      kind: 'refused',
      code: 'bypass_setting',
      setting: 'security.auth.selectedType',
    });
    expect(compat(on, stubRoute, model, p)).not.toHaveProperty('setting', undefined);
    expect(compat(claude, stubRoute, model, { ...p, allowed: [] })).not.toHaveProperty('setting');
  });

  it('R:PR-05 compat allowed set: `*` tail patterns, exact otherwise, regex characters literal', () => {
    const claude = adapterOf(CLI_RUN_FACTS.find((f) => f.id === 'claude')!);
    const only = (modelPattern: string): CompatPolicy =>
      basePolicy({ allowed: [{ adapter: 'claude', route: 'stub:any', modelPattern }] });
    const kind = (id: string, pattern: string): string =>
      compat(claude, stubRoute, { ...model, id }, only(pattern)).kind;
    expect(kind('m-1', 'm-*')).toBe('direct');
    expect(kind('m-1', 'm-1')).toBe('direct');
    expect(kind('m-12', 'm-1')).toBe('refused');
    expect(kind('a.b', 'a.b')).toBe('direct');
    expect(kind('axb', 'a.b')).toBe('refused');
    expect(kind('a.b-9', 'a.*-9')).toBe('direct');
    expect(kind('x', '*')).toBe('direct');
    expect(compat(claude, ownRoute, model, only('*')).kind).toBe('refused');
  });

  it('P109 compat rename invariance: renaming every adapter, route and model id changes no decision', () => {
    const rename = (id: string): string => `renamed-${id.split('').reverse().join('')}`;
    for (const facts of CLI_RUN_FACTS) {
      for (const bypass of [{}, allOff(facts)]) {
        const adapter = adapterOf(facts, bypass);
        for (const route of [stubRoute, ownRoute, loginRoute(facts.id)]) {
          const original = compat(adapter, route, model, basePolicy());
          const renamedAdapter = { ...adapter, id: rename(adapter.id) };
          const binding = route.caps.binding;
          const renamedRoute: CompatRoute = {
            ...route,
            id: rename(route.id),
            caps: {
              ...route.caps,
              binding:
                binding.via === 'cli-login'
                  ? { via: 'cli-login', adapter: rename(binding.adapter) }
                  : binding,
            },
          };
          // Модель по умолчанию CLI (`null`) имени не имеет — переименовывать нечего, шаблон «любая».
          const renamedModel = { ...model, id: model.id === null ? null : rename(model.id) };
          const policy = basePolicy({
            allowed: [
              {
                adapter: renamedAdapter.id,
                route: renamedRoute.id,
                modelPattern: renamedModel.id ?? '*',
              },
            ],
          });
          expect(
            sig(compat(renamedAdapter, renamedRoute, renamedModel, policy)),
            `${facts.id} ${route.id}`,
          ).toBe(sig(original));
        }
      }
    }
  });

  it('P110 compat alternatives: a refusal names the compatible candidates from the same function, never itself or a refused one', () => {
    const facts = (id: string): CliRunFacts => CLI_RUN_FACTS.find((f) => f.id === id)!;
    const aider = adapterOf(facts('aider'));
    const claude = adapterOf(facts('claude'));
    const cursor = adapterOf(facts('cursor'));
    const candidates = [
      { adapter: aider, route: ownRoute, model },
      { adapter: aider, route: stubRoute, model },
      { adapter: claude, route: ownRoute, model },
      { adapter: cursor, route: stubRoute, model },
    ];
    const refused = compat(aider, ownRoute, model, basePolicy({ candidates }));
    expect(refused).toEqual({
      kind: 'refused',
      code: 'window_untellable',
      alternatives: [
        { adapter: 'aider', route: 'stub:any', model: 'm-1', kind: 'direct' },
        { adapter: 'claude', route: 'local:own', model: 'm-1', kind: 'direct' },
      ],
    });
    // Тот же id тройки со свежими фактами (снимок кандидатов старше решения) — это она же, а не
    // альтернатива: сравнение по id, не по объекту и не по вердикту.
    const sameIds = { ...ownRoute, caps: { ...ownRoute.caps, limitsToTell: false } };
    expect(
      compat(
        aider,
        ownRoute,
        model,
        basePolicy({ candidates: [{ adapter: aider, route: sameIds, model }] }),
      ),
    ).toEqual({ kind: 'refused', code: 'window_untellable', alternatives: [] });
    // Альтернатива вне разрешённого набора не названа (подмены за набор нет — P46).
    const narrow = basePolicy({
      candidates,
      allowed: [
        { adapter: 'aider', route: 'local:own', modelPattern: '*' },
        { adapter: 'claude', route: 'local:own', modelPattern: '*' },
      ],
    });
    expect(compat(aider, ownRoute, model, narrow)).toMatchObject({
      alternatives: [{ adapter: 'claude', route: 'local:own' }],
    });
    // Через шлюз — тоже альтернатива, со своим видом.
    const gemini = adapterOf(facts('gemini'), allOff(facts('gemini')));
    expect(
      compat(
        aider,
        ownRoute,
        model,
        basePolicy({ candidates: [{ adapter: gemini, route: stubRoute, model }] }),
      ),
    ).toMatchObject({ alternatives: [{ adapter: 'gemini', kind: 'via-gateway' }] });
  });
});
