import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_EVENT_INFO } from '@agentdeck/contracts';
import { CLAUDE_HOOK_EVENTS } from '@agentdeck/contracts/vocabulary';
import type { EnvItem, EnvNeeds, EnvTrigger } from '@agentdeck/contracts/portable-env';
import { fidelityConditions, fidelityReasons } from '@agentdeck/contracts/portable-fidelity';
import { describeTarget, level } from './fidelity.ts';
import { blockingOfEvent, providerHookEvents } from './hook-events.ts';
import { triggerOfEvent } from './needs.ts';
import { importClaudeEnvironment } from './import/claude.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { buildCapabilities, type ConfigProvider } from '../../providers/types.ts';

/**
 * Матрица верности (П1.1).
 *
 * Проверяется не «функция что-то вернула», а три обещания, на которых держится
 * вся партия: уровень выводится ИЗ ДАННЫХ каталога (выдуманный провайдер
 * получает полный столбец, не изменив ни строки модуля), подмена возможности
 * МЕНЯЕТ матрицу (проверка, которая не может покраснеть, — украшение), и
 * понижение идёт только в сторону строгости (блокирующая запись не становится
 * наблюдательной молча).
 */

const source = {
  provider: 'claude',
  scope: 'global' as const,
  origin: 'file' as const,
  file: '/home/u/.claude/settings.json',
};

/** Запись канона с подставленными полями — общая основа всех случаев. */
function item(over: Partial<EnvItem> & Pick<EnvItem, 'kind'>): EnvItem {
  return {
    id: `${over.kind}:x`,
    source,
    intent: 'запись',
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: { resolution: 'none', why: 'рантайм не нужен' },
    sideEffects: [],
    raw: '',
    ...over,
  } as EnvItem;
}

function hook(over: {
  trigger: EnvTrigger;
  needs: EnvNeeds;
  blocking?: 'blocks' | 'observes';
}): EnvItem {
  return item({
    kind: 'hook',
    command: 'node check.mjs',
    scriptPath: null,
    timeout: null,
    enabled: false,
    trigger: over.trigger,
    blocking: over.blocking ?? 'observes',
    needs: over.needs,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);
}

const TOOL_HOOK = hook({
  trigger: { on: 'tool', event: 'pre_tool', match: null },
  blocking: 'blocks',
  needs: { resolution: 'facts', facts: ['tool_name', 'tool_input'], evidence: 'declared' },
});

const SESSION_HOOK = hook({
  trigger: { on: 'session', event: 'session_start' },
  needs: { resolution: 'facts', facts: ['session_id'], evidence: 'declared' },
});

const SKILL = item({
  kind: 'skill',
  name: 'doc-hygiene',
  description: 'd',
  body: 'b',
  dir: '/home/u/.claude/skills/doc-hygiene',
  enabled: true,
  trigger: { on: 'model' },
} as Partial<EnvItem> & Pick<EnvItem, 'kind'>);

const SECRET = {
  ...item({
    kind: 'secret',
    name: 'ANTHROPIC_API_KEY',
    mask: '…',
    holder: 'panel',
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
};

/** Провайдер, которого в каталоге нет, — именно на нём проверяется §5.4. */
function invented(over: Partial<ConfigProvider> = {}): ConfigProvider {
  return {
    id: 'выдуманный-cli',
    name: 'Выдуманный CLI',
    status: 'experimental',
    paths: () => {
      throw new Error('не используется');
    },
    cli: { command: 'invented', windowsCommand: 'invented.cmd' },
    capabilities: buildCapabilities({}),
    ...over,
  };
}

const allProviders = [claudeProvider, ...CATALOG_PROVIDERS];
const byId = new Map(allProviders.map((provider) => [provider.id, provider]));

/** Провайдер каталога по id — тест обязан упасть, если id исчез, а не молча пропустить случай. */
function provider(id: string): ConfigProvider {
  const found = byId.get(id);
  if (!found) throw new Error(`провайдера ${id} нет в каталоге`);
  return found;
}

const EVERY_KIND: EnvItem[] = [
  item({
    kind: 'instructions',
    fileName: 'CLAUDE.md',
    text: 't',
    includes: [],
    legacy: false,
    enabled: true,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  SKILL,
  item({
    kind: 'command',
    name: 'c',
    namespace: null,
    description: 'd',
    prompt: 'p',
    trigger: { on: 'user' },
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  item({
    kind: 'subagent',
    name: 'a',
    description: 'd',
    tools: null,
    model: null,
    omitInstructions: false,
    trigger: { on: 'model' },
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  TOOL_HOOK,
  SESSION_HOOK,
  item({ kind: 'permission', rule: 'Bash(rm)', decision: 'deny', order: 0 } as Partial<EnvItem> &
    Pick<EnvItem, 'kind'>),
  item({
    kind: 'mcpServer',
    name: 'm',
    transport: 'stdio',
    command: 'node',
    args: [],
    url: null,
    envKeys: [],
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  item({ kind: 'envVar', name: 'E', value: 'v' } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  SECRET,
  item({
    kind: 'plugin',
    name: 'p.ts',
    version: null,
    form: 'module',
    readOnly: false,
    provides: [],
    enabled: true,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
  item({ kind: 'panelGroup', name: 'g', description: 'd', members: [] } as Partial<EnvItem> &
    Pick<EnvItem, 'kind'>),
  item({
    kind: 'conversation',
    title: 't',
    turns: 2,
    lastActiveIso: '2026-09-19T00:00:00.000Z',
    workdir: null,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
];

describe('матрица верности: уровень считается по каталогу, а не по имени CLI', () => {
  it('в модуле нет ни одного идентификатора провайдера — таблицы «провайдер → уровень» не существует', () => {
    const text = readFileSync(new URL('./fidelity.ts', import.meta.url), 'utf8');
    // Комментарии называют провайдеров по-русски и по имени продукта; запрещены
    // именно ИДЕНТИФИКАТОРЫ каталога — по ним и ветвились бы.
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const known of allProviders) {
      expect(code).not.toContain(`'${known.id}'`);
      expect(code).not.toContain(`"${known.id}"`);
    }
  });

  it('выдуманный провайдер с пустым каталогом получает полный столбец: все × с причинами', () => {
    const empty = invented();
    for (const canonItem of EVERY_KIND) {
      const verdict = level(canonItem, empty);
      expect(verdict.level, canonItem.kind).toBe('impossible');
      expect(fidelityReasons).toContain(verdict.reason);
      // У «невозможно» условия быть не может: поднимать нечего.
      expect(verdict.condition).toBeNull();
      expect(verdict.fallback).toBe('impossible');
    }
  });

  it('выдуманный провайдер С возможностями получает нативные уровни — модуль не правится', () => {
    const rich = invented({
      instructionsFile: () => '/x/AGENTS.md',
      skillsConfig: { format: 'skill-md-dir', dir: () => '/x/skills' },
      commandsConfig: { format: 'md-frontmatter', dir: () => '/x/commands' },
      mcpConfig: { format: 'json', path: () => '/x/mcp.json' },
      envConfig: { format: 'dotenv', path: () => '/x/.env' },
      permissionsConfig: {
        format: 'qwen-json',
        path: () => '/x/settings.json',
        model: 'rules',
        decisions: ['allow', 'ask', 'deny'],
      },
    });
    expect(level(EVERY_KIND[0]!, rich).level).toBe('native');
    expect(level(SKILL, rich).level).toBe('native');
    expect(level(EVERY_KIND[8]!, rich).level).toBe('native');
    expect(level(EVERY_KIND[6]!, rich).level).toBe('native');
  });

  it('подмена возможности МЕНЯЕТ матрицу: без каталога скиллов уровень падает', () => {
    const withSkills = invented({
      skillsConfig: { format: 'skill-md-dir', dir: () => '/x/skills' },
      assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: true },
    });
    const withoutSkills = invented({
      assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: true },
    });
    expect(level(SKILL, withSkills).level).toBe('native');
    expect(level(SKILL, withoutSkills).level).toBe('emulated');
  });

  it('скилл, лежащий в каталоге, который цель читает сама, переносить не нужно', () => {
    const shared = invented({
      skillsConfig: {
        format: 'skill-md-dir',
        dir: () => '/x/skills',
        alsoLoadedFrom: () => ['/home/u/.claude/skills'],
      },
    });
    const verdict = level(SKILL, shared);
    expect(verdict.level).toBe('native');
    expect(verdict.reason).toBe('target_shares_location');
  });
});

describe('уровень считается по худшему из требований записи', () => {
  it('хуку с фактами инструмента нужен провод — события сессии его не спасают', () => {
    const withToolEvents = invented({
      hooksConfig: {
        format: 'qwen-json',
        path: () => '/x/settings.json',
        // События одиннадцатого CLI объявлены ЕГО КАТАЛОГОМ — в этом и проверка
        // §5.4: домен о них ничего не знает и знать не должен.
        events: ['PreToolUse', 'PostToolUse', 'SessionStart'],
        // Событие инструмента у формата есть И умеет блокировать — только при
        // обоих условиях запирающий хук переезжает нативно.
        blockingEvents: ['PreToolUse'],
      },
      endpointConfig: {
        'openai-compat': { baseUrlEnv: 'X_BASE_URL', modelEnv: 'X_MODEL', credentialEnv: 'X_KEY' },
      },
    });
    // У формата есть и события инструментов — на них уровень нативный.
    expect(level(TOOL_HOOK, withToolEvents).level).toBe('native');

    // А у цели без механизма хуков вовсе — тот же хук уезжает проводом.
    const wireOnly = invented({
      endpointConfig: {
        'openai-compat': { baseUrlEnv: 'X_BASE_URL', modelEnv: 'X_MODEL', credentialEnv: 'X_KEY' },
      },
      assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: true },
    });
    // Пока панель не открывает ворота на пути запроса, обещания контура нет:
    // уровень «невозможно» со своей причиной, а не «П» с условием, которое
    // ничего не меняет (решение владельца 22.09.2026).
    const closed = level(TOOL_HOOK, wireOnly);
    expect(closed.level).toBe('impossible');
    expect(closed.reason).toBe('tool_events_absent');
    expect(closed.condition).toBeNull();

    // Ворота открыты — приговор возвращается тем же кодом, и вторая половина
    // клетки «П/×» на месте: условие не выполнено — отыгрывать НЕЧЕМ. Подменить
    // вызов «эмуляцией через панель» нельзя: вызовов внутри чужого процесса
    // панель не видит.
    const wired = level(TOOL_HOOK, { ...describeTarget(wireOnly), wireOpened: true });
    expect(wired.level).toBe('wired');
    expect(wired.reason).toBe('tool_events_absent');
    expect(wired.condition).toBe('enable_contour');
    expect(wired.fallback).toBe('impossible');
  });

  it('невыведенные требования считаются «нужно всё»: нативным такой хук не станет', () => {
    const undetermined = hook({
      trigger: { on: 'session', event: 'session_start' },
      needs: { resolution: 'undetermined', why: 'скрипт читает транскрипт' },
    });
    const target = provider('qwen');
    expect(level(SESSION_HOOK, target).level).toBe('native');
    const verdict = level(undetermined, target);
    expect(verdict.level).not.toBe('native');
    expect(verdict.reason).toBe('needs_undetermined');
  });

  it('блокирующий хук на событии, которое блокировать не умеет, не становится наблюдателем молча', () => {
    const blockingPostTool = hook({
      trigger: { on: 'tool', event: 'post_tool', match: null },
      blocking: 'blocks',
      needs: {
        resolution: 'facts',
        facts: ['tool_name', 'tool_input', 'tool_result'],
        evidence: 'declared',
      },
    });
    // У Kimi блокировать умеют ровно три события, `PostToolUse` не из них.
    const verdict = level(blockingPostTool, provider('kimi'));
    expect(verdict.level).not.toBe('native');
    expect(verdict.reason).toBe('blocking_lost');

    // Тот же хук, но наблюдательный, механизм принимает нативно.
    const observing = hook({
      trigger: { on: 'tool', event: 'post_tool', match: null },
      needs: {
        resolution: 'facts',
        facts: ['tool_name', 'tool_input', 'tool_result'],
        evidence: 'declared',
      },
    });
    expect(level(observing, provider('kimi')).level).toBe('native');
  });
});

describe('понижение — только в сторону строгости', () => {
  it('правило «спросить» у цели без такого списка едет запретом и говорит об этом', () => {
    const ask = item({
      kind: 'permission',
      rule: 'Bash(rm)',
      decision: 'ask',
      order: 0,
    } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);
    const cursor = provider('cursor');
    expect(describeTarget(cursor).permissions.decisions).not.toContain('ask');
    const verdict = level(ask, cursor);
    expect(verdict.level).toBe('native');
    expect(verdict.reason).toBe('decision_downgraded');

    const deny = item({
      kind: 'permission',
      rule: 'Bash(rm)',
      decision: 'deny',
      order: 0,
    } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);
    expect(level(deny, cursor).reason).toBe('target_mechanism');
  });

  it('правило у цели с одним лишь режимом записать некуда: провод либо текст', () => {
    const codex = level(
      item({
        kind: 'permission',
        rule: 'Bash(rm)',
        decision: 'deny',
        order: 0,
      } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
      provider('codex'),
    );
    // Ворота на пути запроса закрыты — остаётся текст, и условия контура на
    // экране нет; с открытыми воротами это же правило поднимается до «П» с тем
    // же запасом (проверено в `fidelity-report.test.ts`).
    expect(codex.level).toBe('text');
    expect(codex.condition).toBeNull();
    expect(codex.fallback).toBe('text');

    // У Goose режим тот же, а провода нет вовсе — остаётся текст.
    const goose = level(
      item({
        kind: 'permission',
        rule: 'Bash(rm)',
        decision: 'deny',
        order: 0,
      } as Partial<EnvItem> & Pick<EnvItem, 'kind'>),
      provider('goose'),
    );
    expect(goose.level).toBe('text');
  });
});

describe('приговор всегда полон', () => {
  it('у каждой записи каждого провайдера причина из словаря и согласованное условие', () => {
    for (const target of allProviders) {
      for (const canonItem of EVERY_KIND) {
        const verdict = level(canonItem, target);
        const where = `${target.id}/${canonItem.kind}`;
        expect(fidelityReasons, where).toContain(verdict.reason);
        if (verdict.condition === null) {
          expect(verdict.fallback, where).toBe(verdict.level);
        } else {
          expect(fidelityConditions, where).toContain(verdict.condition);
          // Условие существует ровно затем, чтобы назвать ИНОЙ исход.
          expect(verdict.fallback, where).not.toBe(verdict.level);
        }
      }
    }
  });

  it('секрет не бывает нативным ни у кого: значение канон не носит', () => {
    for (const target of allProviders) {
      const verdict = level(SECRET, target);
      expect(verdict.level, target.id).not.toBe('native');
      if (verdict.level !== 'impossible') {
        expect(verdict.reason, target.id).toBe('value_not_carried');
        expect(verdict.condition, target.id).toBe('run_through_panel');
      }
    }
  });

  it('запись, синхронизированная с аккаунтом, не переносится никуда: тела на диске нет', () => {
    // Скилл и плагин — те два вида, которые CLI умеет держать в аккаунте
    // (2.1.275). Оба обязаны получить `×` У КАЖДОЙ цели, включая ту, у которой
    // раздел есть и файловая запись доехала бы нативно: пустое тело под
    // настоящим именем хуже честного отказа.
    for (const kind of ['skill', 'plugin'] as const) {
      const synced = item({
        kind,
        source: { ...source, origin: 'account', file: null },
        name: 'reviewer',
      } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);
      for (const target of allProviders) {
        const verdict = level(synced, target);
        expect(verdict.level, `${target.id}/${kind}`).toBe('impossible');
        expect(verdict.reason, `${target.id}/${kind}`).toBe('account_only');
      }
    }
  });

  it('MCP-сервер внутри процесса SDK не переносится никуда', () => {
    const sdk = item({
      kind: 'mcpServer',
      name: 'm',
      transport: 'sdk',
      command: null,
      args: [],
      url: null,
      envKeys: [],
    } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);
    for (const target of allProviders) {
      const verdict = level(sdk, target);
      expect(verdict.level, target.id).toBe('impossible');
      expect(verdict.reason, target.id).toBe('in_process_only');
    }
  });

  it('перенос В Claude возможен: у него всё своё, и матрица это видит', () => {
    const profile = describeTarget(claudeProvider);
    expect(profile.subagents).toBe(true);
    expect(profile.permissions.model).toBe('rules');
    for (const canonItem of EVERY_KIND) {
      const verdict = level(canonItem, claudeProvider);
      // Секрет и конструкции панели живут на её запуске — нативными им не быть.
      const panelBound = ['secret', 'panelGroup', 'conversation'].includes(canonItem.kind);
      // Плагин как ЕДИНИЦА — исключение и у Claude: плагины ему ставит магазин,
      // а установка плагинов у цели вне объёма партии (П2.6). Едет содержимое
      // плагина — скиллы, команды, хуки, субагенты обычными записями, и каждая
      // из них в этом же цикле нативна.
      if (canonItem.kind === 'plugin') {
        expect(verdict.level).toBe('impossible');
        // Причина называет ИМЕННО установку, а не отсутствие раздела: плагины у
        // Claude есть, человек их видит в панели, и «механизма нет» он прочёл бы
        // как «у цели такого раздела нет» — неверно и бесполезно.
        expect(verdict.reason).toBe('unit_not_installable');
        continue;
      }
      expect(verdict.level, canonItem.kind).toBe(panelBound ? 'emulated' : 'native');
    }
  });
});

describe('одиннадцатый CLI получает столбец матрицы одним каталогом', () => {
  /**
   * Тот же выдуманный провайдер, но с ПОЛНОСТЬЮ объявленным механизмом хуков.
   * Пока имена событий лежали таблицей форматов внутри `fidelity.ts`, домен не
   * видел механизма нового CLI вовсе: его событие объявлялось отсутствующим у
   * цели, которая его поддерживает, — а §5.4 обещает четыре файла и ни одного в
   * домене.
   */
  const eleventh = invented({
    hooksConfig: {
      format: 'qwen-json',
      path: () => '/x/settings.json',
      events: ['PreToolUse', 'SessionStart'],
      blockingEvents: ['PreToolUse', 'SessionStart'],
    },
    instructionsFile: () => '/x/AGENTS.md',
    // Адрес эндпоинта задокументирован — значит, у записи, которой не хватило
    // события, есть куда деться, и приговор называет ПРИЧИНУ, а не «провода нет».
    endpointConfig: {
      'openai-compat': { baseUrlEnv: 'X_BASE_URL', modelEnv: 'X_MODEL', credentialEnv: 'X_KEY' },
    },
  });

  it('матрица видит РОВНО его события — ни одного лишнего от чужого формата', () => {
    // Сравнение точное, а не «содержит»: пока имена брались по формату из
    // таблицы внутри домена, одиннадцатый CLI получал чужой список целиком —
    // восемнадцать событий Qwen, включая те, которых он не объявлял.
    expect(describeTarget(eleventh).hookEvents).toEqual([
      { trigger: { on: 'tool', event: 'pre_tool', match: null }, blocking: true },
      { trigger: { on: 'session', event: 'session_start' }, blocking: true },
    ]);
  });

  it('хук на его событие нативен, а не «такого события у цели нет»', () => {
    expect(level(TOOL_HOOK, eleventh)).toMatchObject({
      level: 'native',
      reason: 'target_mechanism',
    });
    expect(level(SESSION_HOOK, eleventh)).toMatchObject({
      level: 'native',
      reason: 'target_mechanism',
    });
  });

  it('события, которого он НЕ объявлял, у него нет — даже если оно есть у формата', () => {
    const postTool = hook({
      trigger: { on: 'tool', event: 'post_tool', match: null },
      needs: {
        resolution: 'facts',
        facts: ['tool_name', 'tool_input', 'tool_result'],
        evidence: 'declared',
      },
    });
    const verdict = level(postTool, eleventh);
    expect(verdict.level).not.toBe('native');
    expect(verdict.reason).toBe('tool_events_absent');
  });
});

describe('раздел «только для чтения» — это не «раздела нет»', () => {
  it('плагины Kimi: раздел есть, состоянием владеет сам CLI', () => {
    const plugin = EVERY_KIND.find((canonItem) => canonItem.kind === 'plugin');
    expect(level(plugin!, provider('kimi'))).toMatchObject({
      level: 'impossible',
      reason: 'mechanism_read_only',
    });
  });

  it('хуки OpenCode: причина называет запрет записи, а не отсутствие события', () => {
    // Панель рисует человеку раздел хуков OpenCode — ответ «такого события у
    // цели нет» про CLI, у которого события есть, лишает его единственной
    // действенной половины правды.
    expect(level(SESSION_HOOK, provider('opencode')).reason).toBe('mechanism_read_only');
  });

  it('у цели, где раздела нет вовсе, причина прежняя', () => {
    const plugin = EVERY_KIND.find((canonItem) => canonItem.kind === 'plugin');
    expect(level(plugin!, invented())).toMatchObject({
      level: 'impossible',
      reason: 'no_mechanism',
    });
  });
});

describe('невыведенные требования не выдумывают контур', () => {
  const undeterminedSession = hook({
    trigger: { on: 'session', event: 'session_start' },
    needs: { resolution: 'undetermined', why: 'скрипт читает транскрипт' },
  });

  it('хук сессии не едет проводом: путь запроса событий сессии не видит', () => {
    // Провод сидит в пути ЗАПРОСА. «Нужно всё сразу» добавляет записи факты
    // вызова инструмента, и по ним приговор уходил в `wired` даже там, где
    // контур не может ни запустить хук сессии, ни тем более его заблокировать.
    const wireOnly = invented({
      instructionsFile: () => '/x/AGENTS.md',
      assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: true },
      endpointConfig: {
        'openai-compat': { baseUrlEnv: 'X_BASE_URL', modelEnv: 'X_MODEL', credentialEnv: 'X_KEY' },
      },
    });
    const verdict = level(undeterminedSession, wireOnly);
    expect(verdict.level).not.toBe('wired');
    expect(verdict.condition).not.toBe('enable_contour');
    // Остаётся сила текста: правило названо модели, но не принуждено.
    expect(verdict.level).toBe('text');
  });

  it('событие у цели есть: приговор падает не ниже эмуляции и называет причину', () => {
    const verdict = level(undeterminedSession, provider('qwen'));
    expect(verdict.level).toBe('emulated');
    expect(verdict.reason).toBe('needs_undetermined');
    // Обещание уровня без условия — та же ложь, что потеря записи.
    expect(verdict.condition).toBe('run_through_panel');
  });
});

describe('решение правила заменяется НАЗВАННЫМ, а не подразумевается', () => {
  const denyRule = item({
    kind: 'permission',
    rule: 'Bash(rm)',
    decision: 'deny',
    order: 0,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);

  const askRule = item({
    kind: 'permission',
    rule: 'Bash(rm)',
    decision: 'ask',
    order: 0,
  } as Partial<EnvItem> & Pick<EnvItem, 'kind'>);

  /** Цель, у которой из решений есть ровно одно — разрешение. */
  const allowOnly = invented({
    instructionsFile: () => '/x/AGENTS.md',
    permissionsConfig: {
      format: 'qwen-json',
      path: () => '/x/settings.json',
      model: 'rules',
      decisions: ['allow'],
    },
  });

  it('запрет у цели без запрета НЕ едет разрешением — и вообще не едет нативно', () => {
    // Инвариант 6 держался на удачном составе каталога: у всех шести целей с
    // правилами `deny` есть. Появись одиннадцатая без него — «понижение»
    // отправило бы запрет в единственное доступное значение, то есть сняло его.
    const verdict = level(denyRule, allowOnly);
    expect(verdict.level).not.toBe('native');
    expect(verdict.reason).toBe('decision_unrepresentable');
    expect(verdict.decision).toBeUndefined();
  });

  it('«спросить» у цели с одним разрешением тоже не ослабляется', () => {
    expect(level(askRule, allowOnly).reason).toBe('decision_unrepresentable');
  });

  it('замена названа полем decision: эмиттеру есть что записать', () => {
    const cursor = provider('cursor');
    expect(describeTarget(cursor).permissions.decisions).not.toContain('ask');
    expect(level(askRule, cursor).decision).toBe('deny');
    // Решение, которое цель знает, едет собой — и тоже сказано вслух.
    expect(level(denyRule, cursor).decision).toBe('deny');
  });
});

describe('словари не расходятся молча', () => {
  it('события хуков Claude в словаре и в справочнике интерфейса совпадают', () => {
    const fromInfo = HOOK_EVENT_INFO.map((info) => `${info.event}:${info.canBlock}`).sort();
    const fromVocabulary = CLAUDE_HOOK_EVENTS.map(
      (event) => `${event.name}:${event.blocking}`,
    ).sort();
    expect(fromVocabulary).toEqual(fromInfo);
  });

  it('каталог провайдера с универсальными хуками называет блокирующие события', () => {
    for (const target of CATALOG_PROVIDERS) {
      if (!target.hooksConfig) continue;
      expect(Array.isArray(target.hooksConfig.blockingEvents), target.id).toBe(true);
      // Блокирующее событие обязано быть событием ЭТОГО механизма: список,
      // называющий событие, которого у формата нет, — расхождение двух копий.
      for (const event of target.hooksConfig.blockingEvents) {
        expect(target.hooksConfig.events, `${target.id}/${event}`).toContain(event);
      }
    }
  });

  it('блокировка события берётся у САМОГО CLI, а не из общего словаря канона', () => {
    // Общий ответ на этот вопрос не существует: `Stop` блокирует у Claude и у
    // Kimi, `PermissionRequest` у Kimi — нет. Пока отвечал канон, импорт и
    // матрица стояли по разные стороны одного сравнения.
    expect(blockingOfEvent(claudeProvider, 'Stop')).toBe('blocks');
    expect(blockingOfEvent(provider('kimi'), 'Stop')).toBe('blocks');
    expect(blockingOfEvent(provider('kimi'), 'PermissionRequest')).toBe('observes');
    // Событие, которого у CLI не объявлено, fail-closed считается блокирующим.
    expect(blockingOfEvent(provider('opencode'), 'PreToolUse')).toBe('blocks');
  });
});

describe('перенос в ТОТ ЖЕ CLI нативен по построению', () => {
  /**
   * Проверка идёт по ЖИВОМУ пути: настоящий `settings.json` во временном доме →
   * импортёр → матрица. Рукотворная запись, поданная прямо в `level()`,
   * доказала бы таблицу; ревью волны П1 нашло расхождение именно между
   * ИМПОРТОМ и матрицей — двумя словарями по разные стороны одного сравнения,
   * и увидеть его можно только пройдя оба.
   */
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'fidelity-identity-'));
    mkdirSync(join(home, 'hooks'), { recursive: true });
    // Скрипт читает поле нагрузки — требования выводятся, а не остаются
    // невыведенными: так проверяется именно блокировка, а не `undetermined`.
    writeFileSync(join(home, 'hooks', 'guard.mjs'), 'const s = input.session_id;\n');
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        hooks: {
          // `Stop` и `PreCompact` ОСТАНАВЛИВАЮТ действие у самого Claude —
          // именно они объявлялись потерявшими блокировку при переносе
          // claude → claude.
          Stop: [
            { hooks: [{ type: 'command', command: `node "${join(home, 'hooks', 'guard.mjs')}"` }] },
          ],
          PreCompact: [
            { hooks: [{ type: 'command', command: `node "${join(home, 'hooks', 'guard.mjs')}"` }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: `node "${join(home, 'hooks', 'guard.mjs')}"` }] },
          ],
          // Скрипта нет на диске → требования невыведены. Перенос в тот же CLI
          // от этого нативным быть не перестаёт: событие то же, нагрузка та же.
          SubagentStop: [{ hooks: [{ type: 'command', command: 'node нет-такого.mjs' }] }],
        },
      }),
    );
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function homeHooks(): EnvItem[] {
    const result = importClaudeEnvironment({
      provider: claudeProvider,
      scope: 'global',
      override: home,
    });
    return result.items.filter((canonItem) => canonItem.kind === 'hook');
  }

  it('каждый хук дома доезжает до своего же CLI нативно', () => {
    const hooks = homeHooks();
    expect(hooks).toHaveLength(4);
    for (const canonItem of hooks) {
      expect(level(canonItem, claudeProvider), canonItem.id).toMatchObject({
        level: 'native',
        reason: 'target_mechanism',
        condition: null,
      });
    }
  });

  it('блокирующий Stop доезжает до Kimi и Qwen — у них он тоже блокирует', () => {
    const stop = homeHooks().find((canonItem) => canonItem.id.includes('Stop-'));
    expect(stop).toBeDefined();
    expect(stop?.blocking).toBe('blocks');
    // Мутация «убрать Stop из blockingEvents у kimi/qwen» обязана красить
    // проверку: блокирующий хук стал бы наблюдателем молча (инвариант 6).
    expect(level(stop!, provider('kimi')).level).toBe('native');
    expect(level(stop!, provider('qwen')).level).toBe('native');
  });

  it('каждое объявленное каталогом событие каждого CLI нативно у него самого', () => {
    for (const target of allProviders) {
      for (const event of providerHookEvents(target)) {
        const trigger = triggerOfEvent(event.name, null);
        // Событие, которого канон не знает (`file_edited`), подменять нельзя.
        if (!trigger) continue;
        const canonItem = {
          ...hook({
            trigger,
            needs: { resolution: 'facts', facts: ['session_id'], evidence: 'declared' },
          }),
          blocking: blockingOfEvent(target, event.name),
          source: { ...source, provider: target.id },
        } as EnvItem;
        expect(level(canonItem, target).level, `${target.id}/${event.name}`).toBe('native');
      }
    }
  });
});

describe('общий каталог скиллов — это КАТАЛОГ, а не приставка строки', () => {
  it('выключенный скилл лежит рядом, а не внутри: перенести его всё равно надо', () => {
    const shared = invented({
      skillsConfig: {
        format: 'skill-md-dir',
        dir: () => '/x/skills',
        alsoLoadedFrom: () => ['/home/u/.claude/skills'],
      },
    });
    // `~/.claude/skills-disabled/<id>` начинается с `~/.claude/skills`: сравнение
    // по приставке строки объявило бы «цель читает тот же каталог — переносить
    // нечего», и выключенный скилл исчез бы из переноса молча.
    const disabled = {
      ...SKILL,
      dir: '/home/u/.claude/skills-disabled/doc-hygiene',
    } as EnvItem;
    expect(level(disabled, shared).reason).not.toBe('target_shares_location');
    expect(level(SKILL, shared).reason).toBe('target_shares_location');
  });
});
