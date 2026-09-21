import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CANON_VERSION,
  canonFingerprintInput,
  checkCanonVersion,
  envItemKinds,
  envNeeds,
  isEnvItemKind,
  isEnvNeed,
  type AgentEnvironment,
  type CommandItem,
  type ConversationItem,
  type EnvItem,
  type EnvSource,
  type EnvVarItem,
  type HookItem,
  type InstructionsItem,
  type McpServerItem,
  type PanelGroupItem,
  type PermissionItem,
  type PluginItem,
  type SecretItem,
  type SkillItem,
  type SubagentItem,
} from '@agentdeck/contracts/portable-env';
import {
  agentEnvironmentSchema,
  envItemSchema,
  envNeedsSchema,
} from '@agentdeck/contracts/portable-env-schema';
import { envItemId, maskSecret, needsFacts } from './canon.ts';
import { inferNeedsFromScript } from './needs.ts';

/**
 * Словарь канона переносимой среды (П0.1). Проверяется ровно то, на чём стоит
 * вся партия: закрытый набор `needs`, невозможность отдать запись без него и
 * участие версии канона в отпечатке.
 *
 * Половина проверок здесь — проверки СБОРКИ: строки с `@ts-expect-error`
 * краснеют не в прогоне, а в `pnpm type-check`, и краснеют в обе стороны —
 * сделай `needs` необязательным, и TypeScript пожалуется на лишнее ожидание
 * ошибки. Проверено обоими способами при написании.
 */

const source: EnvSource = {
  provider: 'claude',
  scope: 'global',
  origin: 'file',
  file: '/home/u/.claude/settings.json',
  plugin: null,
};

/**
 * Записи, собранные БЕЗ `needs`. Каждая строка обязана не собираться; их же
 * разбирает схема — тот же запрет на втором этаже, в рантайме.
 */
const withoutNeeds: Record<string, unknown>[] = [];

function keep<T extends EnvItem>(item: T): T {
  withoutNeeds.push(item as unknown as Record<string, unknown>);
  return item;
}

const common = {
  id: 'x',
  source,
  intent: 'зачем это человеку',
  blocking: 'inapplicable',
  sideEffects: [],
} as const;
const always = { on: 'always' } as const;

// @ts-expect-error — `needs` обязателен: запись без требований к рантайму не существует.
keep<InstructionsItem>({
  ...common,
  id: 'instructions:CLAUDE.md',
  kind: 'instructions',
  trigger: always,
  raw: '# rules',
  fileName: 'CLAUDE.md',
  text: '# rules',
  includes: [],
  legacy: false,
  enabled: true,
});
// @ts-expect-error — `needs` обязателен.
keep<SkillItem>({
  ...common,
  id: 'skill:deep-review',
  kind: 'skill',
  trigger: { on: 'model' },
  raw: '---\nname: deep-review\n---',
  name: 'deep-review',
  description: 'ревью кода',
  body: 'тело скилла',
  dir: '/home/u/.claude/skills/deep-review',
  attachments: [{ path: 'references/style.md', bytes: 120, sha256: 'a'.repeat(64) }],
  attachmentsSkipped: [],
  enabled: true,
});
// @ts-expect-error — `needs` обязателен.
keep<CommandItem>({
  ...common,
  id: 'command:review',
  kind: 'command',
  trigger: { on: 'user' },
  raw: 'посмотри ветку',
  name: 'review',
  namespace: null,
  description: 'ревью ветки',
  prompt: 'посмотри ветку',
});
// @ts-expect-error — `needs` обязателен.
keep<SubagentItem>({
  ...common,
  id: 'subagent:explore',
  kind: 'subagent',
  trigger: { on: 'model' },
  raw: '---\nname: explore\n---',
  name: 'explore',
  description: 'поиск по коду',
  tools: ['Read', 'Grep'],
  model: null,
  omitInstructions: true,
});
// @ts-expect-error — `needs` обязателен.
keep<HookItem>({
  ...common,
  id: 'hook:pre-tool-dispatch',
  kind: 'hook',
  trigger: { on: 'tool', event: 'pre_tool', match: 'Bash' },
  blocking: 'blocks',
  sideEffects: ['runs_process'],
  raw: 'node hooks/pre-tool-dispatch.mjs',
  command: 'node hooks/pre-tool-dispatch.mjs',
  scriptPath: '/home/u/.claude/hooks/pre-tool-dispatch.mjs',
  timeout: { value: 5000, unit: 'ms' },
  enabled: false,
});
// @ts-expect-error — `needs` обязателен.
keep<PermissionItem>({
  ...common,
  id: 'permission:Bash(git push:*)',
  kind: 'permission',
  trigger: always,
  blocking: 'blocks',
  raw: 'Bash(git push:*)',
  rule: 'Bash(git push:*)',
  decision: 'deny',
  enabled: true,
  order: 0,
});
// @ts-expect-error — `needs` обязателен.
keep<McpServerItem>({
  ...common,
  id: 'mcpServer:atlassian',
  kind: 'mcpServer',
  trigger: always,
  raw: '{"command":"npx"}',
  name: 'atlassian',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'mcp-atlassian'],
  url: null,
  envKeys: ['ATLASSIAN_TOKEN'],
  enabled: true,
});
// @ts-expect-error — `needs` обязателен.
keep<EnvVarItem>({
  ...common,
  id: 'envVar:EDITOR',
  kind: 'envVar',
  trigger: always,
  raw: 'EDITOR=vim',
  name: 'EDITOR',
  value: 'vim',
});
// @ts-expect-error — `needs` обязателен.
keep<SecretItem>({
  ...common,
  id: 'secret:ANTHROPIC_API_KEY',
  kind: 'secret',
  trigger: always,
  sideEffects: ['reads_secrets'],
  name: 'ANTHROPIC_API_KEY',
  mask: 'sk-…7f2a',
  holder: 'panel',
});
// @ts-expect-error — `needs` обязателен.
keep<PluginItem>({
  ...common,
  id: 'plugin:figma',
  kind: 'plugin',
  trigger: { on: 'model' },
  raw: '{"name":"figma"}',
  name: 'figma',
  version: '1.2.0',
  form: 'installed',
  readOnly: true,
  provides: ['skill', 'command'],
  enabled: true,
});
// @ts-expect-error — `needs` обязателен.
keep<PanelGroupItem>({
  ...common,
  id: 'panelGroup:frontend',
  kind: 'panelGroup',
  trigger: { on: 'user' },
  raw: '{"name":"frontend"}',
  name: 'frontend',
  description: 'набор для фронта',
  members: ['skill:deep-review'],
});
// @ts-expect-error — `needs` обязателен.
keep<ConversationItem>({
  ...common,
  id: 'conversation:abc',
  kind: 'conversation',
  trigger: { on: 'user' },
  raw: '{"id":"abc"}',
  title: 'перенос среды',
  turns: 12,
  lastActiveIso: '2026-09-19T10:00:00.000Z',
  workdir: '/work/agentdeck',
});

/** Те же записи, но с объявленными требованиями: эталон валидной формы. */
const filled: Record<string, unknown>[] = withoutNeeds.map((item) => ({
  ...item,
  needs: { resolution: 'none', why: 'запись статична, рантайм ей не нужен' },
}));

describe('канон переносимой среды: словарь', () => {
  it('модуль словаря самодостаточен — ни одного импорта', () => {
    const file = fileURLToPath(
      new URL('../../../../../packages/contracts/src/portable-env.ts', import.meta.url),
    );
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/^\s*import[\s{*]/m);
    expect(text).not.toMatch(/\brequire\s*\(/);
  });

  it('видов записи двенадцать, и у каждого есть образец в этом наборе', () => {
    expect(envItemKinds).toHaveLength(12);
    expect(new Set(withoutNeeds.map((item) => item.kind))).toEqual(new Set(envItemKinds));
  });

  it('набор фактов рантайма закрыт', () => {
    expect(envNeeds).toEqual([
      'tool_name',
      'tool_input',
      'tool_result',
      'prompt',
      'transcript',
      'cwd',
      'session_id',
      'subagent',
      'compact',
    ]);
    expect(isEnvNeed('tool_input')).toBe(true);
    expect(isEnvNeed('tool_args')).toBe(false);
    expect(isEnvItemKind('hook')).toBe(true);
    expect(isEnvItemKind('cliBehavior')).toBe(false);
    expect(
      envNeedsSchema.safeParse({ resolution: 'facts', facts: ['tool_args'], evidence: 'static' })
        .success,
    ).toBe(false);
  });
});

describe('канон переносимой среды: незаполненный needs', () => {
  it.each(envItemKinds)('запись вида %s без needs не разбирается', (kind) => {
    const item = withoutNeeds.find((candidate) => candidate.kind === kind);
    expect(item).toBeDefined();
    expect(envItemSchema.safeParse(item).success).toBe(false);
    const parsed = envItemSchema.safeParse(filled.find((candidate) => candidate.kind === kind));
    expect(parsed.success).toBe(true);
  });

  it('пустой список фактов — не «ничего не нужно», а отказ', () => {
    const hook = filled.find((item) => item.kind === 'hook');
    expect(
      envItemSchema.safeParse({
        ...hook,
        needs: { resolution: 'facts', facts: [], evidence: 'observed' },
      }).success,
    ).toBe(false);
    expect(
      envItemSchema.safeParse({
        ...hook,
        needs: { resolution: 'facts', facts: ['tool_name', 'tool_input'], evidence: 'observed' },
      }).success,
    ).toBe(true);
  });

  it('невыводимые требования сказаны вслух, а не подменены пустотой', () => {
    expect(envNeedsSchema.safeParse({ resolution: 'undetermined', why: '' }).success).toBe(false);
    expect(
      envNeedsSchema.safeParse({ resolution: 'undetermined', why: 'скрипт читает payload[key]' })
        .success,
    ).toBe(true);
  });
});

describe('канон переносимой среды: секрет', () => {
  it('значение ключа в канон не попадает — его негде держать', () => {
    const secret = filled.find((item) => item.kind === 'secret');
    const parsed = envItemSchema.safeParse({
      ...secret,
      raw: 'sk-ant-МАРКЕР',
      value: 'sk-ant-МАРКЕР',
    });
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.success ? parsed.data : {})).not.toContain('МАРКЕР');
  });
});

describe('канон переносимой среды: версия', () => {
  const env: AgentEnvironment = {
    canonVersion: CANON_VERSION,
    provider: 'claude',
    scope: 'global',
    root: '/home/u/.claude',
    capturedAt: '2026-09-19T10:00:00.000Z',
    items: [],
    sectionStates: [],
    skipped: [
      { kind: 'plugin', reason: 'no_section', detail: 'у провайдера нет раздела плагинов' },
    ],
  };

  it('чужая версия названа вслух, а не прочитана «почти так же»', () => {
    expect(checkCanonVersion(CANON_VERSION)).toEqual({ readable: true });
    // Словарь пока первой версии, поэтому «паспорт старше» проверяется сравнением
    // с будущей: ветка исполняется сегодня, а не ждёт второй версии.
    expect(checkCanonVersion(CANON_VERSION, CANON_VERSION + 1)).toEqual({
      readable: false,
      reason: 'older_canon',
    });
    expect(checkCanonVersion(CANON_VERSION + 1)).toEqual({
      readable: false,
      reason: 'newer_canon',
    });
    expect(checkCanonVersion('1')).toEqual({ readable: false, reason: 'not_a_canon' });
    expect(checkCanonVersion(0)).toEqual({ readable: false, reason: 'not_a_canon' });
    expect(checkCanonVersion(1.5)).toEqual({ readable: false, reason: 'not_a_canon' });
    expect(
      agentEnvironmentSchema.safeParse({ ...env, canonVersion: CANON_VERSION + 1 }).success,
    ).toBe(false);
    expect(agentEnvironmentSchema.safeParse(env).success).toBe(true);
  });

  it('версия стоит первой строкой отпечатка: её смена меняет отпечаток', () => {
    const now = canonFingerprintInput(env);
    const next = canonFingerprintInput({
      ...env,
      canonVersion: (CANON_VERSION + 1) as typeof CANON_VERSION,
    });
    expect(now.startsWith(`canon:${CANON_VERSION}`)).toBe(true);
    expect(next).not.toBe(now);
  });

  it('правка содержимого записи меняет отпечаток', () => {
    // Ради этого отпечаток и существует: подписка сверяет им «человек правил
    // файл цели руками» (инвариант 7). Считаясь по виду, `id`, `blocking`,
    // `needs` и побочным действиям, он не менялся ни от переписанного правила,
    // ни от подменённой команды хука — правку переписали бы молча.
    const hook = filled.find((item) => item.kind === 'hook') as unknown as EnvItem;
    const edited = { ...hook, command: 'node ./совсем-другой-скрипт.mjs' } as EnvItem;

    expect(canonFingerprintInput({ ...env, items: [edited] })).not.toBe(
      canonFingerprintInput({ ...env, items: [hook] }),
    );
  });

  it('отпечаток не зависит от порядка ключей внутри записи', () => {
    const hook = filled.find((item) => item.kind === 'hook') as unknown as EnvItem;
    const reordered = Object.fromEntries(
      Object.entries(hook as unknown as Record<string, unknown>).reverse(),
    ) as unknown as EnvItem;

    expect(canonFingerprintInput({ ...env, items: [reordered] })).toBe(
      canonFingerprintInput({ ...env, items: [hook] }),
    );
  });

  it('отпечаток не зависит от порядка записей', () => {
    const hook = filled.find((item) => item.kind === 'hook') as unknown as EnvItem;
    const skill = filled.find((item) => item.kind === 'skill') as unknown as EnvItem;
    expect(canonFingerprintInput({ ...env, items: [hook, skill] })).toBe(
      canonFingerprintInput({ ...env, items: [skill, hook] }),
    );
  });
});

describe('идентичность записи канона', () => {
  it('имена, различающиеся только регистром, — разные записи', () => {
    // Два MCP-сервера одного конфига: `Context7` и `context7`. Сложенные в
    // нижний регистр, они давали один `id`, а по нему идёт идемпотентный upsert
    // (инвариант 10) — у цели одна запись затёрла бы другую, и на
    // регистронезависимой ФС этого не увидел бы никто.
    expect(envItemId('mcpServer', 'Context7')).not.toBe(envItemId('mcpServer', 'context7'));
  });

  it('имя, из которого приведение что-то выбросило, несёт хвост различия', () => {
    const first = envItemId('permission', 'Bash(echo "exit=$?")');
    const second = envItemId('permission', 'Bash(echo "exit $?")');

    expect(first).not.toBe(second);
    // Хвост детерминирован: тот же дом даёт тот же отпечаток среды.
    expect(envItemId('permission', 'Bash(echo "exit=$?")')).toBe(first);
  });

  it('обычное имя остаётся читаемым и хвоста не получает', () => {
    expect(envItemId('skill', 'doc-hygiene')).toBe('skill:doc-hygiene');
    expect(envItemId('envVar', 'EDITOR')).toBe('envVar:EDITOR');
  });
});

describe('сборка needs и маски: отказ вместо тихой подмены', () => {
  it('пустой список фактов — ошибка вызова, а не «ничего не нужно»', () => {
    // Раньше функция возвращала `needsNone(whyIfEmpty)`, а все её вызовы
    // передавали пустую строку: получалось `{resolution:'none', why:''}` — тело,
    // которое отвергает СОБСТВЕННАЯ схема канона, то есть маршрут ответил бы
    // паспортом, а страница показала бы «паспорт нечитаем».
    expect(() => needsFacts([], 'declared')).toThrow(/пуст/);
    expect(envNeedsSchema.safeParse({ resolution: 'none', why: '' }).success).toBe(false);
    expect(needsFacts(['tool_name'], 'declared')).toEqual({
      resolution: 'facts',
      facts: ['tool_name'],
      evidence: 'declared',
    });
  });

  it('маска не показывает короткое значение целиком', () => {
    // `hunter` → `hu…nter` показывало больше знаков, чем в самом значении.
    expect(maskSecret('hunter')).toBe('…');
    expect(maskSecret('abc12345')).toBe('…');
    expect(maskSecret('sk-ant-0123456789')).toBe('sk…6789');
  });
});

describe('статический разбор скрипта: форма доступа, а не слово', () => {
  const factsOf = (text: string): readonly string[] => {
    const parsed = inferNeedsFromScript(text);
    return parsed.kind === 'facts' ? [...parsed.facts].sort() : ['<undetermined>'];
  };

  it('слово в комментарии или в имени переменной требованием не считается', () => {
    // Скрипт ниже не читает нагрузку ВООБЩЕ: `trigger` — слово комментария,
    // `cwd` — часть имени собственной переменной. Проверка по целому слову
    // объявляла факты `compact` и `cwd`, а по `needs` матрица вычисляет уровень
    // верности — лишний факт занижает его переносимому перехватчику.
    expect(
      factsOf(
        [
          '#!/usr/bin/env node',
          '// trigger: запускается на каждом вызове',
          'const cwdLog = 1;',
          'console.log("ok");',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('каждая из настоящих форм доступа факт даёт', () => {
    expect(factsOf('const name = payload.tool_name;')).toEqual(['tool_name']);
    expect(factsOf('const name = payload["tool_name"];')).toEqual(['tool_name']);
    expect(factsOf('echo "$tool_name"')).toEqual(['tool_name']);
    expect(factsOf('jq -r .cwd')).toEqual(['cwd']);
    expect(factsOf('const { tool_input } = JSON.parse(raw);')).toEqual(['tool_input']);
  });
});
