import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  envItemKinds,
  type AgentEnvironment,
  type EnvItem,
} from '@agentdeck/contracts/portable-env';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { importEnvironment } from './import/index.ts';
import { emitEnvironment, emitterProviderIds, hasEmitter } from './emit/index.ts';
import { UnknownEmitProviderError, type EmitPlan } from './emit/types.ts';
import { KINDS_NOT_YET_EMITTED } from './emit/context.ts';
import { level } from './fidelity.ts';
import { panelSupervisorHooks } from './supervisor/panel-hooks.ts';

/**
 * Эмиттеры среды (П2.1): канон → десять CLI.
 *
 * Проверка идёт НА ЖИВЫХ ФАЙЛАХ и настоящими адаптерами: временный дом,
 * настоящий импортёр Claude собирает канон, настоящие эмиттеры раскладывают его
 * по домам целей, а результат читается с диска. Рукотворный паспорт, поданный
 * прямо в эмиттер, доказал бы таблицу, а не систему — а вопрос этой волны
 * ровно в том, что окажется в чужом файле.
 *
 * Дом один на все десять: у целей, которые читают каталог Claude сами
 * (`kimi`, `opencode`), перекрытие каталогов обязано быть НАСТОЯЩИМ, иначе
 * «копия не нужна» проверялась бы на выдуманном условии.
 */

/** Значение-маркер: попало на диск цели — проверка обязана покраснеть. */
const SECRET_VALUE = 'sk-ant-МАРКЕР-1b7e4d3a-НЕ-ДОЛЖЕН-УТЕЧЬ';

/** Текст человека в чужом файле: он обязан пережить перенос дословно. */
const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';

/** След настоящего запуска скрипта хука: файл с этим текстом пишет сам скрипт. */
const HOOK_MARK = 'хук исполнился';

let home: string;
let env: AgentEnvironment;
const savedEnv = { ...process.env };
const PROVIDERS = [claudeProvider, ...CATALOG_PROVIDERS];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'portability-emit-'));
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.QWEN_HOME = join(home, '.qwen');
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code');
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  delete process.env.CLAUDE_CONFIG_DIR;

  writeSourceHome(home);
  writeForeignNeighbours(home);
  env = importEnvironment({ provider: claudeProvider, scope: 'global' });
});

afterAll(() => {
  for (const key of [
    'HOME',
    'USERPROFILE',
    'CODEX_HOME',
    'QWEN_HOME',
    'KIMI_CODE_HOME',
    'XDG_CONFIG_HOME',
    'APPDATA',
    'CLAUDE_CONFIG_DIR',
  ]) {
    // Присвоение `undefined` записало бы строку «undefined» — переменную надо
    // именно убрать, иначе следующий файл тестов читал бы несуществующий дом.
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

/** Записать файл, создав каталоги по пути. */
function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом-источник: по разделу на каждый слой, который эта волна возит. */
function writeSourceHome(root: string): void {
  const claude = join(root, '.claude');
  put(
    join(claude, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET_VALUE },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'node ./format.mjs', timeout: 5 }],
          },
          // Скрипта этого хука на диске НЕТ, и файл рядом не создаётся намеренно:
          // §7 требует, чтобы такая запись доехала строкой с причиной и НЕ
          // зарегистрировалась у цели.
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: `node ${join(claude, 'hooks', 'gone.mjs')}`, timeout: 5 },
            ],
          },
        ],
        // Второй хук зовёт НАСТОЯЩИЙ скрипт по абсолютному пути в написании ЭТОЙ
        // ОС (на Windows — с обратными косыми). Чужой CLI обязан получить путь в
        // виде, который исполнится, а не в том, каким его рисует проводник
        // (П2.6): проверка ниже запускает записанную команду оболочкой.
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `node ${join(claude, 'hooks', 'mark.mjs')}`, timeout: 5 },
            ],
          },
        ],
        // Хук СЕССИИ: фактов вызова инструмента ему не нужно, поэтому у цели без
        // своих хуков приговор — «эмуляцией». Ниже проверяется, чем эта эмуляция
        // оборачивается на самом деле.
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `node ${join(claude, 'hooks', 'greet.mjs')}`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    }),
  );
  // Скрипт сессионного хука читает только то, что панель знает о СВОЁМ запуске:
  // ни имени инструмента, ни его ввода — иначе приговор ушёл бы в провод.
  put(
    join(claude, 'hooks', 'greet.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const input = JSON.parse(readFileSync(0, 'utf8') || '{}');",
      'process.stdout.write(String(input.session_id ?? ""));',
      '',
    ].join('\n'),
  );
  // Скрипт хука: он не копируется переносом — его зовут по его собственному пути
  // на этой же машине, поэтому он обязан лежать на диске и запускаться.
  put(
    join(claude, 'hooks', 'mark.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      // Путь метки приезжает окружением, а не аргументом: между конфигом цели и
      // этим скриптом теперь стоит переходник (П3.3), и нагрузку он передаёт
      // через stdin — argv до скрипта человека не доходит и доходить не должен.
      `writeFileSync(process.env.HOOK_MARK_PATH ?? process.argv[2], ${JSON.stringify(HOOK_MARK)}, 'utf8');`,
      '',
    ].join('\n'),
  );
  put(
    join(claude, 'CLAUDE.md'),
    ['Преамбула источника.', '', '## ПРАВИЛО: По-русски', '', 'По-русски.', ''].join('\n'),
  );
  put(
    join(claude, 'skills', 'doc-hygiene', 'SKILL.md'),
    [
      '---',
      'name: doc-hygiene',
      'description: Порядок в документах',
      '---',
      '',
      'Тело скилла.',
      '',
    ].join('\n'),
  );
  // Вложение скилла: скилл — это КАТАЛОГ, и справка внутри него обязана доехать
  // до цели файлом, а не остаться у источника (П2.6).
  put(join(claude, 'skills', 'doc-hygiene', 'references', 'style.md'), 'Справка скилла.\n');
  // Выключенный скилл: у Claude состояние файловое — он физически лежит в
  // `skills-disabled/`, и у цели с таким же выключателем обязан остаться
  // выключенным.
  put(
    join(claude, 'skills-disabled', 'sleeping', 'SKILL.md'),
    ['---', 'name: sleeping', 'description: Спящий скилл', '---', '', 'Спит.', ''].join('\n'),
  );
  put(
    join(claude, 'commands', 'review.md'),
    ['---', 'description: Ревью изменений', '---', '', 'Посмотри диф.', ''].join('\n'),
  );
  put(
    join(claude, 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: Ревьюер',
      'tools: Read, Grep',
      'disallowedTools: Bash, Write',
      'omitClaudeMd: true',
      '---',
      '',
      'Смотри внимательно.',
      '',
    ].join('\n'),
  );
  // Спутник `.claude.json` лежит РЯДОМ с домашним каталогом, а не внутри него —
  // так его ищет сам CLI (`resolveMcpConfig`). Положенный внутрь, он не
  // прочитался бы вовсе, и раздел MCP молча выпал бы из проверки.
  put(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'mcp-files'], env: { FILES_TOKEN: SECRET_VALUE } },
        // ВТОРОЙ сервер здесь не для полноты: у целей оба MCP ложатся в ОДИН
        // файл, и с одним сервером в фикстуре вся проверка «несколько записей
        // одного слоя в один файл» не выполнялась ни разу. На настоящем доме
        // (четыре сервера) план падал 500, и юниты этого не видели.
        docs: { command: 'npx', args: ['-y', 'mcp-docs'] },
      },
      // Выключенный сервер лежит в служебном ключе панели и едет записью с
      // `enabled: false`: у цели с таким же ключом он обязан лечь туда же.
      mcpServersDisabled: {
        sleeping: { command: 'npx', args: ['-y', 'mcp-sleeping'] },
      },
    }),
  );
}

/**
 * Соседние записи в домах целей: текст человека в файле инструкций и чужой
 * ключ в конфиге. Перенос обязан оставить и то и другое по значению.
 */
function writeForeignNeighbours(root: string): void {
  put(join(root, '.codex', 'AGENTS.md'), `${HUMAN_TEXT}\n`);
  put(
    join(root, '.codex', 'config.toml'),
    ['model = "o3"', '', '[mcp_servers.neighbour]', 'command = "мой-сервер"', ''].join('\n'),
  );
  // Файл человека с меткой порядка байтов и окончаниями Windows: так его
  // оставляют Блокнот и git с `core.autocrlf`. Перенос обязан вернуть файл в
  // той же форме — смешанные окончания «портят» его на вид и ломают дифф.
  put(join(root, '.gemini', 'GEMINI.md'), `\ufeff${HUMAN_TEXT}\r\n`);
  put(
    join(root, '.gemini', 'settings.json'),
    JSON.stringify({ theme: 'мой', mcpServers: { neighbour: { command: 'мой-сервер' } } }),
  );
  // Своё правило у цели: порядок правил Kimi значим, и перенос обязан и
  // сохранить чужую строку, и не переставить её ради своих.
  put(
    join(root, '.kimi-code', 'config.toml'),
    [
      'default_permission_mode = "manual"',
      '',
      '[[permission.rules]]',
      'decision = "deny"',
      'pattern = "Bash(shutdown*)"',
      '',
    ].join('\n'),
  );
}

/**
 * Дом ЦЕЛИ для Claude — отдельный каталог, а не тот, из которого снят канон.
 *
 * Перенос в свой же CLI бывает двух видов, и проверять надо оба смысла: сюда
 * едет «на другую машину, в другой каталог», где всё обязано доехать записями.
 * Перенос в тот же самый каталог проверяют правила перекрытия (`kimi`,
 * `opencode`) и повторное применение плана.
 */
function overrideOf(providerId: string): string | undefined {
  return providerId === 'claude' ? join(home, '.claude-target') : undefined;
}

/** План для цели плюс применение всех его правок. */
function emitAndApply(providerId: string): EmitPlan {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`провайдера «${providerId}» нет в каталоге`);
  const plan = emitEnvironment(env, {
    target: provider,
    scope: 'global',
    override: overrideOf(providerId),
  });
  for (const write of plan.writes) write.apply();
  return plan;
}

/** Исходы записей плана по виду — в порядке появления. */
function outcomes(plan: EmitPlan, kind: EnvItem['kind']): string[] {
  return plan.entries.filter((entry) => entry.kind === kind).map((entry) => entry.outcome);
}

/** Снимок файлов, которые затронул план. */
function snapshot(plan: EmitPlan): Map<string, string> {
  const files = new Map<string, string>();
  for (const write of plan.writes) {
    files.set(
      write.filePath,
      existsSync(write.filePath) ? readFileSync(write.filePath, 'utf8') : '',
    );
  }
  return files;
}

/**
 * Строки целевого файла, в которых встречается кусок текста, — по РАЗОБРАННОЙ
 * структуре, а не по тексту файла: в JSON и TOML путь записан с экранированием,
 * и поиск по сырому тексту проверял бы экранирование вместо самой команды.
 */
function stringsWith(value: unknown, needle: string): string[] {
  if (typeof value === 'string') return value.includes(needle) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => stringsWith(entry, needle));
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((entry) => stringsWith(entry, needle));
  }
  return [];
}

describe('реестр эмиттеров', () => {
  it('заведён у всех десяти провайдеров', () => {
    expect(emitterProviderIds()).toHaveLength(10);
    for (const provider of PROVIDERS) expect(hasEmitter(provider.id)).toBe(true);
  });

  it('цели без эмиттера план не строится', () => {
    const unknown = { ...claudeProvider, id: 'одиннадцатый' };
    expect(() => emitEnvironment(env, { target: unknown, scope: 'global' })).toThrow(
      UnknownEmitProviderError,
    );
  });
});

describe('план эмиссии', () => {
  it('каждая запись канона получает ровно одну строку у каждой цели', () => {
    for (const provider of PROVIDERS) {
      const plan = emitEnvironment(env, {
        target: provider,
        scope: 'global',
        override: overrideOf(provider.id),
      });
      const answered = plan.entries.map((entry) => entry.itemId);
      // Проверка живёт в `buildPlan` и бросает; здесь важно, что она исполнена
      // для ВСЕХ десяти, а не для одной цели, на которой её однажды позвали.
      expect(new Set(answered).size).toBe(answered.length);
      const carried = env.items.filter((item) => answered.includes(item.id));
      expect(carried.length).toBeGreaterThan(0);
    }
  });

  /**
   * Список пропускаемых видов — ЕДИНСТВЕННЫЙ способ исчезнуть из плана молча, и
   * тест сторожит именно это: пока вид числится в нём, его записи не получают
   * строки вовсе, а всякий другой вид без эмиттера роняет построение.
   *
   * Без такого теста список рос бы правкой в одну строку: вид, чей эмиттер
   * тяжело писать, дописывают сюда — и его записи перестают доезжать у всех
   * десяти целей, не сказав об этом ни строкой плана, ни красным тестом.
   */
  it('список невозимых видов закрыт и состоит из настоящих видов канона', () => {
    expect(Object.keys(KINDS_NOT_YET_EMITTED).sort()).toEqual(['conversation', 'panelGroup']);
    // Опечатка в ключе не пропускает ничего, зато читается как пропуск: вид,
    // который хотели отложить, полетел бы в эмиттеры и уронил план.
    for (const kind of Object.keys(KINDS_NOT_YET_EMITTED)) {
      expect(envItemKinds as readonly string[]).toContain(kind);
    }
    // И тикет назван у каждого: «отложено» без тикета — это «забыто».
    for (const ticket of Object.values(KINDS_NOT_YET_EMITTED)) expect(ticket).toMatch(/^П\d/);
  });

  it('вид без эмиттера и без записи в списке роняет план, а не исчезает', () => {
    const alien = {
      ...(env.items[0] as EnvItem),
      id: 'widget:невиданный',
      kind: 'widget',
    } as unknown as EnvItem;
    const withAlien: AgentEnvironment = { ...env, items: [...env.items, alien] };

    // Падение НАЗЫВАЕТ запись — по какой бы из двух проверок оно ни случилось
    // (приговор не вынесен либо строки нет): вопрос теста в том, что вид без
    // эмиттера не проходит молча, а не в том, кто именно его остановил.
    expect(() => emitEnvironment(withAlien, { target: claudeProvider, scope: 'global' })).toThrow(
      /«widget:невиданный»/,
    );
  });

  it('вложение скилла с путём наружу каталога план не строит', () => {
    // Опись вложений — единственная строка канона, из которой складывается путь
    // ЦЕЛИ посегментно. Сегодня её пишет наш импортёр, но канон умеет приезжать
    // файлом, и `..` в описи означал бы запись мимо каталога скилла.
    const skill = env.items.find((entry) => entry.kind === 'skill');
    const poisoned = {
      ...(skill as EnvItem),
      attachments: [{ path: '../../эксфильтрат.md', bytes: 3, sha256: 'x' }],
    } as EnvItem;
    const withPoison: AgentEnvironment = {
      ...env,
      items: env.items.map((entry) => (entry.id === poisoned.id ? poisoned : entry)),
    };

    expect(() => emitEnvironment(withPoison, { target: claudeProvider, scope: 'global' })).toThrow(
      /небезопасному пути «\.\.\/\.\.\/эксфильтрат\.md»/,
    );
    // И отказ едет С КОДОМ: маршрут отвечает им названным 409, а английский
    // интерфейс переводит его своим словарём — иначе человек увидел бы 500 и
    // русскую строку.
    let thrown: unknown;
    try {
      emitEnvironment(withPoison, { target: claudeProvider, scope: 'global' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      messageCode: 'portability-attachment-unsafe-path',
      params: { path: '../../эксфильтрат.md' },
    });
  });

  it('уровень приговора назван у каждой строки', () => {
    const plan = emitEnvironment(env, { target: claudeProvider, scope: 'global' });
    for (const entry of plan.entries) {
      expect(entry.verdict.level).toBeTruthy();
      expect(entry.verdict.reason).toBeTruthy();
    }
  });
});

describe('перенос в Claude', () => {
  it('субагент сохраняет запрет инструментов, которого канон не носит', () => {
    const plan = emitAndApply('claude');
    const written = plan.entries.find((entry) => entry.kind === 'subagent');
    expect(written?.outcome).toBe('written');

    const text = readFileSync(join(home, '.claude-target', 'agents', 'reviewer.md'), 'utf8');
    // Ключ отнимает доступ. Потерять его значило бы ВЕРНУТЬ субагенту то, что
    // человек у него забрал, — единственная потеря, расширяющая права.
    expect(text).toContain('disallowedTools:');
    expect(text).toContain('Bash, Write');
    expect(text).toContain('omitClaudeMd: true');
  });

  it('значение секрета не ложится ни в один файл цели', () => {
    const plan = emitAndApply('claude');
    for (const [, text] of snapshot(plan)) expect(text).not.toContain(SECRET_VALUE);
  });

  it('повторное применение того же плана не создаёт вторую запись', () => {
    const plan = emitAndApply('claude');
    const first = snapshot(plan);
    for (const write of plan.writes) write.apply();
    for (const [path, text] of snapshot(plan)) expect(text).toBe(first.get(path));

    // Имя файла инструкций у цели решает тот же резолвер, что и на экране (П2.7):
    // дом цели пуст, своего `CLAUDE.md` там нет — CLI прочитает `AGENTS.md`, и
    // запись идёт ровно туда. Прежняя константа завела бы файл, который у цели
    // молча побеждает уже лежащий рядом.
    const instructions = readFileSync(join(home, '.claude-target', 'AGENTS.md'), 'utf8');
    expect(instructions.match(/agentdeck:portability:begin/g) ?? []).toHaveLength(1);
    expect(instructions).toContain('Преамбула источника.');
  });

  it('хук с чужой машины не включается записью', () => {
    // Канон, приехавший извне, несёт хук выключенным (инвариант 9). Здесь
    // источник — собственный дом, поэтому хук действует и записывается; проверка
    // держит саму связь «выключен у источника → строка, а не запись».
    const plan = emitAndApply('claude');
    const disabled = { ...env, items: env.items.map(disable) };
    const strict = emitEnvironment(disabled, {
      target: claudeProvider,
      scope: 'global',
      override: overrideOf('claude'),
    });
    expect(outcomes(strict, 'hook')).toContain('disabled_at_source');
    expect(outcomes(plan, 'hook')).toContain('written');
  });

  it('хук с пропавшим скриптом едет строкой и НЕ регистрируется у цели', () => {
    const plan = emitAndApply('claude');
    const row = plan.entries.find((entry) => entry.intent.includes('gone.mjs'));

    // Строка есть — молчание человек прочитал бы как «доехало».
    expect(row?.outcome).toBe('script_missing');
    // Приговор при этом НАТИВНЫЙ: механизм у цели тот же, и причина отказа не в
    // нём. Разведи их здесь — и в отчёте верности запись перестанет быть видна.
    expect(row?.verdict.level).toBe('native');
    expect(row?.file).toBeNull();

    // И главное: в файле цели записи нет. Зарегистрированный хук с
    // несуществующим скриптом падал бы на каждом `PostToolUse`.
    const settings = join(home, '.claude-target', 'settings.json');
    const text = existsSync(settings) ? readFileSync(settings, 'utf8') : '';
    expect(text).not.toContain('gone.mjs');
    // Соседний хук того же события доезжает — отказ точечный, а не «раздел не поехал».
    expect(text).toContain('mark.mjs');
  });

  it('вложения скилла доезжают файлами, а не остаются у источника', () => {
    emitAndApply('claude');
    const copied = join(home, '.claude-target', 'skills', 'doc-hygiene', 'references', 'style.md');

    // Скилл, доехавший одним `SKILL.md`, у цели ссылается на файлы, которых там
    // нет: он выглядит перенесённым и не работает.
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf8')).toBe('Справка скилла.\n');
  });

  it('выключенный скилл приезжает ВЫКЛЮЧЕННЫМ — в каталог выключенных', () => {
    const plan = emitAndApply('claude');
    const row = plan.entries.find((entry) => entry.intent.includes('sleeping'));

    // У Claude состояние скилла файловое: выключенный физически лежит в
    // `skills-disabled/`. Записать его в рабочий каталог значило бы включить то,
    // что человек выключил сам.
    expect(row?.outcome).toBe('written');
    expect(row?.file).toContain('skills-disabled');
    const target = join(home, '.claude-target');
    expect(existsSync(join(target, 'skills-disabled', 'sleeping', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'skills', 'sleeping', 'SKILL.md'))).toBe(false);
  });

  it('выключенный MCP-сервер приезжает выключенным, а не действующим', () => {
    const plan = emitAndApply('claude');
    const write = plan.writes.find((entry) => entry.kind === 'mcpServer');
    expect(write).toBeDefined();
    const config = JSON.parse(readFileSync(write?.filePath ?? '', 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;

    // Ключ служебный, но смысл его человеческий: сервер у цели есть и молчит —
    // ровно как у источника.
    expect(Object.keys(config.mcpServersDisabled ?? {})).toContain('sleeping');
    expect(Object.keys(config.mcpServers ?? {})).not.toContain('sleeping');
    expect(Object.keys(config.mcpServers ?? {})).toContain('files');
  });
});

/** Тот же паспорт, но всё, что умеет выключаться, выключено. */
function disable(item: EnvItem): EnvItem {
  return 'enabled' in item ? { ...item, enabled: false } : item;
}

describe('перенос в чужие CLI', () => {
  it('текст человека в файле инструкций остаётся дословно', () => {
    for (const id of ['codex', 'gemini']) {
      const plan = emitAndApply(id);
      const instructions = plan.writes.find((write) => write.kind === 'instructions');
      expect(instructions).toBeDefined();
      const text = readFileSync(instructions?.filePath ?? '', 'utf8');
      expect(text).toContain(HUMAN_TEXT);
      expect(text).toContain('agentdeck:portability:begin');
    }
  });

  it('соседние записи и чужие ключи целевого файла остаются по значению', () => {
    emitAndApply('codex');
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('мой-сервер');

    emitAndApply('gemini');
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('мой');
    expect(settings.mcpServers.neighbour.command).toBe('мой-сервер');
  });

  it('форма чужого файла — метка порядка байтов и окончания строк — сохраняется', () => {
    emitAndApply('gemini');
    const text = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('agentdeck:portability:begin');
    // Смешанные окончания — самая заметная порча чужого файла: голый LF не
    // должен остаться ни одного, иначе дифф человека станет целиком красным.
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('цель, читающая каталог источника, копии скилла не получает', () => {
    // Перекрытие каталогов берётся из КАТАЛОГА возможностей, а не из имени
    // провайдера: `opencode` читает `~/.claude/skills`, `kimi` — только
    // `~/.agents/skills`, и каждый проверяется своим настоящим условием.
    // Скиллов в доме два: действующий и выключенный. Выключенный у формата без
    // выключателя не пишется вовсе — записанный скилл действовал бы (П2.6).
    const shared = emitAndApply('opencode');
    expect(outcomes(shared, 'skill').sort()).toEqual(['already_available', 'disabled_at_source']);
    expect(shared.writes.some((write) => write.kind === 'skill')).toBe(false);

    const kimi = PROVIDERS.find((provider) => provider.id === 'kimi');
    if (!kimi) throw new Error('kimi нет в каталоге');
    const copied = emitEnvironment(env, { target: kimi, scope: 'global' });
    expect(outcomes(copied, 'skill').sort()).toEqual(['disabled_at_source', 'written']);

    // Тот же скилл, лежащий в каталоге, который kimi читает сам, копии уже не
    // получает — условие одно, а не два разных на два провайдера.
    const inAgents = join(home, '.agents', 'skills', 'doc-hygiene');
    const moved = {
      ...env,
      items: env.items.map((item) => (item.kind === 'skill' ? { ...item, dir: inAgents } : item)),
    };
    const skipped = emitEnvironment(moved, { target: kimi, scope: 'global' });
    expect(outcomes(skipped, 'skill')).toEqual(['already_available', 'already_available']);
    expect(skipped.writes.some((write) => write.kind === 'skill')).toBe(false);
  });

  it('скилл, синхронизированный с аккаунтом, не пишется пустым телом ни у одной цели', () => {
    // Тела на диске у такой записи нет (`origin: 'account'`, 2.1.275). Записать
    // её значит создать у цели скилл с настоящим именем и пустым содержимым —
    // вид переноса вместо переноса. Проверяются ВСЕ десять целей, включая те,
    // у кого раздел скиллов свой и файловая запись доезжает нативно.
    const synced = {
      ...env,
      items: env.items.map((item) =>
        item.kind === 'skill'
          ? {
              ...item,
              dir: null,
              source: { ...item.source, origin: 'account' as const, file: null },
            }
          : item,
      ),
    };
    for (const provider of PROVIDERS) {
      const plan = emitEnvironment(synced, { target: provider, scope: 'global' });
      expect(outcomes(plan, 'skill'), provider.id).toEqual([
        'not_transferable',
        'not_transferable',
      ]);
      expect(
        plan.writes.some((write) => write.kind === 'skill'),
        provider.id,
      ).toBe(false);
      const row = plan.entries.find((entry) => entry.kind === 'skill');
      expect(row?.verdict.reason, provider.id).toBe('account_only');
    }
  });

  it('выключенные право и MCP-сервер не приезжают действующими ни к одной цели', () => {
    // Круговой прогон нашёл это на настоящих файлах: выключенный сервер
    // приезжал к девяти целям работающим. У чужих форматов выключателя нет —
    // значит записать такую запись нечем, и единственный честный исход тот же,
    // что у скилла и хука: «выключено у источника» (П2.6).
    const disabled = { ...env, items: env.items.map(disable) };
    for (const provider of CATALOG_PROVIDERS) {
      const plan = emitEnvironment(disabled, { target: provider, scope: 'global' });
      for (const kind of ['permission', 'mcpServer'] as const) {
        expect(outcomes(plan, kind), provider.id).not.toContain('written');
        expect(
          plan.writes.some((write) => write.kind === kind),
          provider.id,
        ).toBe(false);
        const native = plan.entries.filter(
          (entry) => entry.kind === kind && entry.verdict.level === 'native',
        );
        for (const entry of native) {
          expect(entry.outcome, `${provider.id}: ${entry.intent}`).toBe('disabled_at_source');
        }
      }
    }
  });

  it('команда хука у цели ИСПОЛНЯЕТСЯ и доводит до скрипта человека', () => {
    // Скрипты хуков не копируются: у цели остаётся ссылка на файл источника, и
    // единственная честная проверка «написание целевой ОС» — запустить то, что
    // записано, из ЧУЖОГО рабочего каталога. Относительный путь здесь не найдёт
    // скрипт, а обратная косая в строке команды будет съедена оболочкой.
    //
    // С П3.3 в конфиге стоит не скрипт человека, а переходник рядом с конфигом:
    // он приводит нагрузку хозяина к форме Claude и зовёт исходный скрипт по его
    // пути. Поэтому цепочка проверяется целиком — исполняется то, что записано в
    // конфиг, а доказательством остаётся файл, который написал скрипт ЧЕЛОВЕКА.
    for (const id of ['qwen', 'kimi']) {
      const plan = emitAndApply(id);
      const write = plan.writes.find((entry) => entry.kind === 'hook');
      expect(write, id).toBeDefined();

      const filePath = write?.filePath ?? '';
      const text = readFileSync(filePath, 'utf8');
      const parsed: unknown = filePath.endsWith('.toml') ? parseToml(text) : JSON.parse(text);
      const [command] = stringsWith(parsed, 'hook-shim');
      expect(command, `${id}: команды хука в ${filePath} нет`).toBeDefined();
      // Путь скрипта человека в конфиг больше не пишется — он живёт в переходнике.
      expect(stringsWith(parsed, 'mark.mjs'), id).toHaveLength(0);

      const marker = join(home, `запуск-${id}.txt`);
      const run = spawnSync('sh', ['-c', command ?? ''], {
        cwd: home,
        encoding: 'utf8',
        // Нагрузка хозяина уходит переходнику через stdin — тем же способом, каким
        // её отдаст сам CLI.
        input: JSON.stringify({ event: 'UserPromptSubmit', prompt: 'вопрос' }),
        env: { ...process.env, HOOK_MARK_PATH: marker },
      });
      expect(run.status, `${id}: ${command ?? ''} → ${run.stderr}`).toBe(0);
      expect(readFileSync(marker, 'utf8'), id).toBe(HOOK_MARK);
    }
  });

  /**
   * ЧЕМ ОБОРАЧИВАЕТСЯ «ЭМУЛЯЦИЕЙ» У ХУКА, ПЕРЕНЕСЁННОГО В ЦЕЛЬ БЕЗ ХУКОВ.
   *
   * Уровень Э обещает человеку: «механизма у цели нет, поведение держит панель
   * вокруг своего запуска». У хука это обещание сегодня не выполняется, и
   * проверка держит ровно этот факт, а не желаемое: на диск цели запись не
   * ложится (`runtime_only` — писателя у неё нет), а надзиратель чужого прогона
   * собирается ИЗ СОСТОЯНИЯ ПАНЕЛИ и канона не читает вовсе.
   *
   * Сказано это и человеку — в справке и в `docs/LIMITATIONS-PROVIDERS.ru.md`.
   * Появится чтение хуков канона рантаймом — проверка покраснеет и заставит
   * переписать обе стороны разом, а не разойтись молча.
   */
  it('хук уровня «эмуляцией» не едет ни файлом, ни надзирателем', () => {
    const sessionHook = env.items.find(
      (item) => item.kind === 'hook' && item.trigger.on === 'session',
    );
    if (!sessionHook) throw new Error('сессионного хука нет в каноне — фикстура изменилась');

    const codex = PROVIDERS.find((provider) => provider.id === 'codex');
    if (!codex) throw new Error('codex нет в каталоге');
    expect(level(sessionHook, codex).level).toBe('emulated');

    const plan = emitAndApply('codex');
    const entry = plan.entries.find((candidate) => candidate.itemId === sessionHook.id);
    expect(entry?.outcome).toBe('runtime_only');
    expect(plan.writes.some((write) => write.itemIds.includes(sessionHook.id))).toBe(false);

    // Конец пути: что бы ни лежало в каноне, надзиратель играет только записи
    // самой панели — выключенная калитка и пустой список групп дают пусто.
    expect(
      panelSupervisorHooks({
        settings: { promptGate: { enabled: false, action: 'block' } },
        groups: [],
        hooksDir: join(home, 'hooks'),
        skillsDir: join(home, 'skills'),
      }),
    ).toEqual([]);
  });

  it('повторное применение не удваивает записи ни у одной цели', () => {
    for (const provider of PROVIDERS) {
      const plan = emitAndApply(provider.id);
      const first = snapshot(plan);
      for (const write of plan.writes) write.apply();
      for (const [path, text] of snapshot(plan)) {
        // Имя цели входит в сравниваемую строку: иначе красный скажет «тексты
        // разные», не назвав, у какого из десяти CLI второй прогон раздвоил файл.
        expect(`${provider.id} ${path}\n${text}`).toBe(
          `${provider.id} ${path}\n${first.get(path)}`,
        );
      }
    }
  });

  it('значение секрета не ложится на диск ни одной цели', () => {
    for (const provider of PROVIDERS) {
      const plan = emitAndApply(provider.id);
      for (const [path, text] of snapshot(plan)) {
        if (text.includes(SECRET_VALUE)) throw new Error(`${provider.id}: секрет в ${path}`);
      }
    }
  });
});

describe('права (П2.2)', () => {
  it('kimi: чужое правило цело и стоит первым, наши — следом и в порядке канона', () => {
    const plan = emitAndApply('kimi');
    const text = readFileSync(join(home, '.kimi-code', 'config.toml'), 'utf8');

    // Чужая строка не просто цела — она ПЕРВАЯ: порядок файла принадлежит его
    // хозяину, и вставка своих правил в начало переписала бы смысл всего списка.
    const order = [...text.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['Bash(shutdown*)', 'Bash(git status)', 'Read(./private)']);
    expect(text).toContain('default_permission_mode = "manual"');

    // Режим источника (`mode:*`) правилом не становится ни у кого.
    expect(text).not.toContain('mode:');
    expect(outcomes(plan, 'permission')).toContain('written');
  });

  it('opencode: имя переводится задокументированным словарём, чужое имя не пишется', () => {
    emitAndApply('opencode');
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    ) as { permission?: Record<string, unknown> };

    // `Bash(git status)` → карта шаблонов `bash`; `Read(./private)` у OpenCode
    // выразить нечем — и запрет, который ничего не запрещает, туда не ложится.
    expect(config.permission?.bash).toEqual({ 'git status': 'allow' });
    expect(Object.keys(config.permission ?? {})).not.toContain('Read');
  });

  it('claude: правила доезжают своими списками, повтор плана не удваивает их', () => {
    emitAndApply('claude');
    const settingsPath = join(home, '.claude-target', 'settings.json');
    const read = (): { permissions?: { allow?: string[]; deny?: string[] } } =>
      JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        permissions?: { allow?: string[]; deny?: string[] };
      };

    expect(read().permissions?.allow).toContain('Bash(git status)');
    expect(read().permissions?.deny).toContain('Read(./private)');

    emitAndApply('claude');
    expect(read().permissions?.allow?.filter((rule) => rule === 'Bash(git status)')).toHaveLength(
      1,
    );
  });

  it('claude: выключенное правило в файл не попадает — записанное действует', () => {
    // У Claude выключенное правило в `settings.json` не лежит вовсе: его хранит
    // состояние панели. Записать его значило бы ВКЛЮЧИТЬ у цели то, что человек
    // выключил сам, — и для запрета это изменение прав (П2.6).
    const disabled = { ...env, items: env.items.map(disable) };
    const target = join(home, '.claude-off');
    const plan = emitEnvironment(disabled, {
      target: claudeProvider,
      scope: 'global',
      override: target,
    });
    expect(outcomes(plan, 'permission')).not.toContain('written');

    for (const write of plan.writes) write.apply();
    const settingsPath = join(target, 'settings.json');
    const text = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
    expect(text).not.toContain('Bash(git status)');
    expect(text).not.toContain('Read(./private)');
  });
});
