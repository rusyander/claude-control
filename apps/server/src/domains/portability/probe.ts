import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvScope } from '@agentdeck/contracts/portable-env';
import type {
  ProbeLayer,
  ProbeObservation,
  ProbeReport,
  ProbeRow,
  ProbeSkipReason,
} from '@agentdeck/contracts/portable-probe';
import {
  expectedObservation,
  probeLayers,
  summarizeProbe,
} from '@agentdeck/contracts/portable-probe';
import { findCliOnPath } from '../../providers/detect.ts';
import { providerCliCandidates } from '../../providers/cli.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import type { ProviderEndpointApiKind } from '../../providers/types/assistant.ts';
import { emitEnvironment } from './emit/index.ts';
import { level } from './fidelity.ts';
import { PROBE_MARKS, probeEnvironment, writeProbeScripts } from './probe-canon.ts';
import type { ProbeScripts } from './probe-canon.ts';
import { startProbeStub, type StubBlock } from './probe-stub.ts';

/**
 * ПРИЁМОЧНАЯ ПРОБА (П2.4): отчёт верности из прогноза становится измерением.
 *
 * Матрица (П1) считает, чего ждать от цели. Проба идёт и смотрит, что произошло:
 * поднимает НАСТОЯЩИЙ целевой CLI во временном доме, куда теми же эмиттерами
 * положены шесть пробных записей, отвечает ему заглушкой вместо модели и
 * сверяет две колонки — «обещано» и «проверено». Расхождение между ними — дефект
 * ПЕРЕНОСА, а не пробы.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, которые важнее удобства:
 *
 *  1. **Временный дом, а не дом человека.** Проба пишет шесть записей, запускает
 *     чужой процесс и ждёт, что он что-то заблокирует. Делать это в настоящих
 *     файлах человека нельзя ни при каком результате — ни при успехе, ни,
 *     особенно, при обрыве посередине. Дом создаётся целиком и удаляется целиком.
 *
 *     Дом уводится в сторону не только `HOME`/`USERPROFILE`, но и СВОИМИ
 *     переменными каждого CLI (`homeEnv`): живой прогон 20.09.2026 (claude
 *     2.1.263) показал, что без `CLAUDE_CONFIG_DIR` цель читает настоящий
 *     `~/.claude` человека, и отчёт тогда говорил о ЕГО среде, а не о пробной.
 *
 *     ЧЕГО ЭТО НЕ ЗАКРЫВАЕТ, и умолчать об этом нельзя. Системный временный
 *     каталог на Windows лежит ВНУТРИ профиля человека, а целевой CLI ищет
 *     инструкции проекта, поднимаясь от рабочего каталога вверх, — и доходит до
 *     его `CLAUDE.md`. Тот же прогон с временным каталогом вне профиля этого
 *     чтения уже не даёт. На приговоры это не влияет: моделью отвечает
 *     заглушка, идущая по неизменному сценарию, и текст чужих инструкций не
 *     может ни покрасить строку, ни перекрасить. Проба при этом не пишет за
 *     пределами своего дома и никуда, кроме петли, ничего не отправляет.
 *  2. **Источник у пробных записей СВОЙ** (`agentdeck-probe`), а не тот CLI,
 *     откуда идёт перенос. Приговор `target_shares_location` — ответ про ПАРУ
 *     («переносить нечего, они читают один каталог»), а проба спрашивает про
 *     МЕХАНИЗМ цели. Общий каталог означал бы, что писать нечего, — то есть и
 *     мерить нечего, и шесть строк «не проверено» сказали бы неправду о цели.
 *  3. **Зелёного по умолчанию не бывает.** Любая ступень, на которой прогон не
 *     состоялся — нет бинаря, нет рецепта, нет заглушке адреса, CLI не ответил,
 *     — даёт «не проверено» с названной причиной. Наблюдение `absent` считается
 *     ответом ТОЛЬКО когда цель действительно отработала запрос.
 *  4. **Наблюдают по НЕГАТИВУ там, где механизм обязан останавливать.** Хук и
 *     право признаются сработавшими не по тексту чужого отказа (он у каждого CLI
 *     свой и меняется от версии), а по тому, что условленный вывод ТАК И НЕ
 *     ПОЯВИЛСЯ, хотя вызов был сделан. Текст отказа едет в `detail` для человека,
 *     но приговор от него не зависит.
 */

/** Сколько ждём целевой CLI. Один короткий прогон — минуты ему не нужны. */
const RUN_TIMEOUT_MS = 90_000;

/**
 * РЕЦЕПТ пробы одного CLI: как его запустить без диалога и какими именами он
 * зовёт свои инструменты.
 *
 * Это не «таблица провайдер → уровень», которую план запрещает (§5.4): уровень
 * по-прежнему считает матрица из каталога возможностей. Здесь лежит то, что из
 * каталога не выводится и выводиться не может, — argv неинтерактивного запуска и
 * СОБСТВЕННЫЕ имена инструментов CLI. Выдумать их нельзя: заглушка, позвавшая
 * несуществующий инструмент, покрасит пробу про себя, а не про перенос. Поэтому
 * цель без рецепта честно «не проверена», а список сокращается правкой кода.
 */
interface ProbeRecipe {
  /** Диалект заглушки; он же ключ в `endpointConfig` каталога. */
  readonly apiKind: ProviderEndpointApiKind;
  /** Неинтерактивный запуск с готовым промптом. */
  args(prompt: string): readonly string[];
  /** Имя инструмента оболочки и поле, в котором он ждёт команду. */
  readonly shellTool: { readonly name: string; readonly arg: string };
  /** Имя инструмента чтения файла и поле пути. */
  readonly readTool: { readonly name: string; readonly arg: string };
  /** Чем запрос вызывает пробную слэш-команду. */
  readonly commandPrompt: string;
  /** Подготовить временный дом до запуска: снять мастера первого запуска и т.п. */
  prepare?(home: string, workdir: string): void;
}

const RECIPES: Readonly<Record<string, ProbeRecipe>> = {
  claude: {
    apiKind: 'anthropic',
    // `--allowedTools` разрешает ДВА инструмента, без которых проба слепа: без
    // них печатный режим откажет в вызове сам, и «хук заблокировал» стало бы
    // неотличимо от «до хука не дошло». Запрет пробного права при этом остаётся
    // в силе: правила `deny` у Claude Code сильнее любых разрешений.
    args: (prompt) => ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Bash,Read'],
    shellTool: { name: 'Bash', arg: 'command' },
    readTool: { name: 'Read', arg: 'file_path' },
    commandPrompt: '/agentdeck-probe-command',
    prepare: (home) => {
      // Мастер первого запуска в пустом доме спросил бы про доверие к каталогу и
      // повис бы без ответа. Файл лежит РЯДОМ с домом, а не внутри него — так
      // его ищет сам CLI.
      //
      // ДОПИСЫВАЕМ, а не создаём заново: в этот же файл эмиттер только что
      // положил пробный MCP-сервер, и запись целиком стёрла бы его — проба
      // краснела бы на слое MCP от собственной подготовки.
      // Путь — по правилу самого CLI: при заданном `CLAUDE_CONFIG_DIR` файл
      // лежит ВНУТРИ каталога (`claude-paths.mcp-config.test.ts`), и проба
      // задаёт эту переменную. Сосед `~/.claude.json` здесь не читался бы вовсе,
      // а вместе с ним не читался бы и пробный MCP-сервер.
      const path = join(home, '.claude', '.claude.json');
      let current: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
      } catch {
        current = {};
      }
      writeFileSync(
        path,
        JSON.stringify({
          ...current,
          hasCompletedOnboarding: true,
          bypassPermissionsModeAccepted: true,
          projects: (current.projects as Record<string, unknown> | undefined) ?? {},
        }),
        'utf8',
      );
    },
  },
};

/** Что нужно пробе. Дом человека сюда не приходит вовсе — и прийти не может. */
export interface ProbeDeps {
  readonly target: ConfigProvider;
  readonly scope: EnvScope;
  /** Ограничение прогона; по умолчанию `RUN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * Чем запускать цель ВМЕСТО найденного бинаря — argv целиком.
   *
   * Существует ради одного: проверить саму пробу на ПОДДЕЛЬНОМ CLI
   * (`tools/qa/check-portability-probe.mjs`), потому что девяти настоящих на
   * машине нет. Массивом, а не строкой, чтобы подделка звалась без оболочки:
   * `[process.execPath, '.../probe-fake-cli.mjs']`. В работе панели поле пустое
   * — иначе «что мы запускали» решал бы вызывающий.
   */
  readonly cliOverride?: readonly string[];
}

/**
 * Прогнать пробу. Одна попытка, один прогон цели, шесть строк — всегда шесть,
 * даже когда ни одна не проверена.
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const target = deps.target;
  const ranAt = new Date().toISOString();
  const recipe = RECIPES[target.id];
  const candidates = providerCliCandidates(target);
  // Подделка считается установленной целью: проверять на ней «а нашёлся ли
  // бинарь» значило бы проверять `where`, а не пробу.
  const argv = deps.cliOverride ?? asArgv(findCliOnPath([...candidates]));
  const found = argv !== null;
  const cliCommand = argv?.join(' ') ?? candidates[0] ?? target.cli.command;

  const report = (rows: readonly ProbeRow[]): ProbeReport => ({
    target: target.id,
    scope: deps.scope,
    ranAt,
    cliCommand,
    cliInstalled: found,
    rows,
    summary: summarizeProbe(rows),
  });

  const promised = promisedLevels(target, deps.scope);
  const refuse = (reason: ProbeSkipReason): ProbeReport =>
    report(probeLayers.map((layer) => skipped(layer, promised, reason, '')));

  if (!recipe) return refuse('no_probe_recipe');
  if (!found) return refuse('cli_not_installed');
  const endpoint = target.endpointConfig?.[recipe.apiKind];
  if (!endpoint) return refuse('no_stub_endpoint');

  const home = mkdtempSync(join(tmpdir(), 'agentdeck-probe-'));
  try {
    const workdir = join(home, 'work');
    const scratch = join(home, 'probe');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(workdir, PROBE_MARKS.deniedFile), PROBE_MARKS.deniedContent, 'utf8');

    let scripts: ProbeScripts;
    try {
      scripts = plantProbeEnvironment(target, deps.scope, home, scratch, workdir);
    } catch {
      // Пробная среда для этой цели не собралась — писать было нечем. Причина
      // остаётся кодом: текст ошибки эмиттера цитирует чужие пути.
      return refuse('emit_failed');
    }
    recipe.prepare?.(home, workdir);

    const stub = await startProbeStub(scriptFor(recipe, scripts));
    try {
      const [command, ...prefix] = argv;
      const run = await runTarget({
        command: command ?? '',
        args: [...prefix, ...recipe.args(recipe.commandPrompt)],
        /** Оболочка нужна только настоящему бинарю (.cmd-обёртка на Windows). */
        shell: deps.cliOverride === undefined,
        cwd: workdir,
        env: {
          ...homeEnv(home),
          [endpoint.baseUrlEnv]: stub.baseUrl,
          ...(endpoint.credentialEnv ? { [endpoint.credentialEnv]: 'agentdeck-probe' } : {}),
        },
        timeoutMs: deps.timeoutMs ?? RUN_TIMEOUT_MS,
      });

      if (run.timedOut) return refuse('timed_out');
      if (stub.requests.length === 0) {
        // Цель не дошла до модели ни разу: мерить нечего, и «ничего не
        // наблюдали» здесь означало бы провал переноса, которого не было.
        return report(
          probeLayers.map((layer) =>
            skipped(layer, promised, 'run_failed', firstLine(run.stderr || run.stdout)),
          ),
        );
      }

      return report(observe(stub.requests, promised));
    } finally {
      await stub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Найденный бинарь как argv; не нашёлся — `null`, а не пустая строка. */
function asArgv(command: string | undefined): readonly string[] | null {
  return command === undefined ? null : [command];
}

/**
 * ШЕСТЬ СТРОК по тому, что цель прислала заглушке, — отдельной точкой входа.
 *
 * Тест таблицы приговоров кормит её готовыми телами запросов: решение «обещано
 * против проверено» обязано иметь свой красный, не зависящий от того, стоит ли
 * на машине хоть один чужой CLI. Настоящую дорогу целиком проверяет
 * `tools/qa/check-portability-probe.mjs` на поддельном CLI — таблица её не
 * заменяет и заменить не может.
 */
export function probeRowsFrom(
  requests: readonly Record<string, unknown>[],
  target: ConfigProvider,
  scope: EnvScope,
): readonly ProbeRow[] {
  return observe(requests, promisedLevels(target, scope));
}

/**
 * Что панель ОБЕЩАЛА по каждому слою — тем же `fidelity.ts`, что и отчёт
 * верности. Второго вычисления уровня здесь нет и быть не должно: проба обязана
 * мерить то самое обещание, которое человек прочитал на экране.
 */
function promisedLevels(
  target: ConfigProvider,
  scope: EnvScope,
): ReadonlyMap<ProbeLayer, { level: ReturnType<typeof level>['level']; itemId: string }> {
  const scripts = { hookPath: '', mcpPath: '', skillDir: '', forbiddenPath: '', envPath: '' };
  const env = probeEnvironment({
    source: PROBE_SOURCE,
    scope,
    root: '',
    scripts,
    capturedAt: new Date(0).toISOString(),
  });
  const map = new Map<ProbeLayer, { level: ReturnType<typeof level>['level']; itemId: string }>();
  for (const item of env.items) {
    if (!(probeLayers as readonly string[]).includes(item.kind)) continue;
    map.set(item.kind as ProbeLayer, { level: level(item, target).level, itemId: item.id });
  }
  return map;
}

/** Синтетический источник пробных записей — см. решение 2 в шапке модуля. */
const PROBE_SOURCE = 'agentdeck-probe';

/**
 * Разложить пробную среду по ВРЕМЕННОМУ дому цели теми же эмиттерами.
 *
 * Дом цели вычисляется из переменных окружения процесса (`HOME`, `CODEX_HOME`,
 * `XDG_CONFIG_HOME` и так далее), и другого способа увести его в сторону у
 * панели нет. Подмена держится ровно на время СИНХРОННОГО участка: ни
 * `emitEnvironment`, ни `write.apply` не содержат ни одного `await`, а значит
 * ни один другой запрос сервера не может вклиниться между подменой и возвратом —
 * событийный цикл до `finally` не проворачивается. Появится здесь первое
 * `await` — подмена станет гонкой, и это тот случай, когда комментарий важнее
 * кода.
 */
function plantProbeEnvironment(
  target: ConfigProvider,
  scope: EnvScope,
  home: string,
  scratch: string,
  /**
   * Рабочий каталог прогона — он же ПРОЕКТ пробы: цель запускается с `cwd` в
   * нём, и проектные файлы она ищет именно здесь. На глобальном уровне поле не
   * значит ничего.
   */
  workdir: string,
): ProbeScripts {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, homeEnv(home));

    const scripts = writeProbeScripts(scratch);
    const env = probeEnvironment({
      source: PROBE_SOURCE,
      scope,
      root: scope === 'project' ? workdir : home,
      scripts,
      capturedAt: new Date().toISOString(),
    });
    // `override` не передаётся намеренно: ручной каталог панели указывает на
    // НАСТОЯЩИЙ дом человека, и проба записала бы шесть своих файлов туда.
    const plan = emitEnvironment(env, { target, scope, projectRoot: workdir });
    for (const write of plan.writes) write.apply(undefined);
    return scripts;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

/**
 * Дом провайдера во временном каталоге. Имена переменных — те же, по которым
 * каждый CLI ищет свои файлы; основа списка — круговой инвариант
 * (`tools/qa/check-portability-roundtrip.mjs`), и второй его копии заводить
 * нельзя — они разошлись бы на одиннадцатом CLI.
 *
 * `CLAUDE_CONFIG_DIR` — ДОБАВКА пробы, и разница не косметическая: круговой
 * инвариант уводит в сторону только ЭМИТТЕР (свой же код), а проба обязана
 * увести и настоящий чужой процесс. Живой прогон 20.09.2026 (claude 2.1.263)
 * показал, что `HOME`/`USERPROFILE` для этого недостаточно: CLI всё равно
 * прочитал НАСТОЯЩИЙ `~/.claude/CLAUDE.md` человека и отправил его модели.
 * Переменная — документированный способ этого CLI назвать свой каталог, и
 * эмиттер её слушает: `.claude.json` он при ней кладёт ВНУТРЬ каталога, ровно
 * туда, где CLI его и ищет.
 */
function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    QWEN_HOME: join(home, '.qwen'),
    KIMI_CODE_HOME: join(home, '.kimi-code'),
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: join(home, 'AppData', 'Roaming'),
  };
}

/**
 * Сценарий заглушки: один ход с тремя вызовами инструментов, потом точка.
 *
 * Три вызова в ОДНОМ ходе, а не три прогона: тикет просит «шесть проб, один
 * короткий прогон», и каждый лишний запуск чужого CLI — это ещё десяток секунд
 * и ещё один способ не завершиться.
 */
function scriptFor(
  recipe: ProbeRecipe,
  scripts: ProbeScripts,
): (turn: number) => readonly StubBlock[] {
  return (turn) => {
    if (turn > 0) return [{ type: 'text', text: 'Проба завершена.' }];
    return [
      {
        type: 'tool_use',
        id: 'probe_forbidden',
        name: recipe.shellTool.name,
        input: { [recipe.shellTool.arg]: `node "${scripts.forbiddenPath}"` },
      },
      {
        type: 'tool_use',
        id: 'probe_env',
        name: recipe.shellTool.name,
        input: { [recipe.shellTool.arg]: `node "${scripts.envPath}"` },
      },
      {
        type: 'tool_use',
        id: 'probe_denied',
        name: recipe.readTool.name,
        input: { [recipe.readTool.arg]: PROBE_MARKS.deniedFile },
      },
    ];
  };
}

/**
 * Разбор наблюдений по тому, что цель прислала заглушке.
 *
 * Первый запрос отвечает за три слоя, которые обязаны ДОЕХАТЬ ДО МОДЕЛИ: слово
 * скилла, развёрнутый текст команды, имя инструмента MCP. Ответы инструментов
 * (второй запрос) отвечают за три слоя, которые обязаны ПОДЕЙСТВОВАТЬ.
 */
function observe(
  requests: readonly Record<string, unknown>[],
  promised: ReturnType<typeof promisedLevels>,
): ProbeRow[] {
  const first = JSON.stringify(requests[0] ?? {});
  const messages = JSON.stringify((requests[0] ?? {}).messages ?? []);
  const tools = JSON.stringify((requests[0] ?? {}).tools ?? []);
  const results = requests.slice(1).map((request) => JSON.stringify(request.messages ?? []));
  const answered = results.join('\n');
  const toolsRan = requests.length > 1;

  const row = (
    layer: ProbeLayer,
    observed: ProbeObservation,
    detail: string,
    skip: ProbeSkipReason | null = null,
  ): ProbeRow => decide(layer, promised, observed, detail, skip);

  return [
    // Хук обязан ОСТАНОВИТЬ запрещённый вызов: вывод, которого нет, и есть
    // доказательство. Отказ хука цитируется в подробности, но не решает.
    toolsRan
      ? row(
          'hook',
          answered.includes(PROBE_MARKS.forbiddenRan) ? 'absent' : 'enforced',
          answered.includes(PROBE_MARKS.hookBlocked) ? PROBE_MARKS.hookBlocked : '',
        )
      : row('hook', 'unknown', '', 'run_failed'),
    row('skill', first.includes(PROBE_MARKS.skill) ? 'present' : 'absent', PROBE_MARKS.skill),
    row(
      'permission',
      toolsRan ? (answered.includes(PROBE_MARKS.deniedContent) ? 'absent' : 'enforced') : 'unknown',
      '',
      toolsRan ? null : 'run_failed',
    ),
    row(
      'mcpServer',
      tools.includes(PROBE_MARKS.mcpTool) ? 'present' : 'absent',
      PROBE_MARKS.mcpTool,
    ),
    toolsRan
      ? row(
          'envVar',
          answered.includes(`${PROBE_MARKS.envEcho}${PROBE_MARKS.env}`) ? 'present' : 'absent',
          PROBE_MARKS.env,
        )
      : row('envVar', 'unknown', '', 'run_failed'),
    row(
      'command',
      messages.includes(PROBE_MARKS.command) ? 'present' : 'absent',
      PROBE_MARKS.command,
    ),
  ];
}

/** Строка отчёта: обещание, ожидание, наблюдение и приговор между ними. */
function decide(
  layer: ProbeLayer,
  promised: ReturnType<typeof promisedLevels>,
  observed: ProbeObservation,
  detail: string,
  skip: ProbeSkipReason | null,
): ProbeRow {
  const promise = promised.get(layer);
  const promisedLevel = promise?.level ?? 'impossible';
  const expected = expectedObservation(layer, promisedLevel);

  // Уровни «эмуляция» и «провод» измеряет не проба: до надзирателя рантайма
  // (П3) и провода (П4) строка честно не проверена, а не зелена.
  if (!expected) {
    return {
      layer,
      itemId: promise?.itemId ?? '',
      promised: promisedLevel,
      expected: 'unknown',
      observed: 'unknown',
      verdict: 'not_checked',
      skip: promisedLevel === 'emulated' ? 'needs_panel_runtime' : 'needs_wire',
      detail: '',
    };
  }

  if (skip || observed === 'unknown') {
    return {
      layer,
      itemId: promise?.itemId ?? '',
      promised: promisedLevel,
      expected,
      observed: 'unknown',
      verdict: 'not_checked',
      skip: skip ?? 'run_failed',
      detail,
    };
  }

  return {
    layer,
    itemId: promise?.itemId ?? '',
    promised: promisedLevel,
    expected,
    observed,
    verdict: observed === expected ? 'match' : 'mismatch',
    skip: null,
    detail,
  };
}

/** Строка «не проверено» до всякого прогона — причина уже известна. */
function skipped(
  layer: ProbeLayer,
  promised: ReturnType<typeof promisedLevels>,
  reason: ProbeSkipReason,
  detail: string,
): ProbeRow {
  return decide(layer, promised, 'unknown', detail, reason);
}

/** Что вернул прогон цели. Коды выхода не решают ничего: решают наблюдения. */
interface TargetRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Запуск цели.
 *
 * Окружение собирается ЯВНО и ничего лишнего не наследует: ключи панели,
 * её адрес модели и её каталог настроек в чужом процессе пробы делать нечего —
 * с ними проба мерила бы среду панели, а не перенесённую.
 */
function runTarget(params: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  shell: boolean;
}): Promise<TargetRun> {
  return new Promise((resolve) => {
    const child = spawn(params.command, [...params.args], {
      cwd: params.cwd,
      env: { ...baseEnv(), ...params.env },
      // На Windows CLI обычно стоит .cmd-обёрткой, и без оболочки её не найти —
      // то же решение, что у раннера ассистента. Подделке оболочка не нужна и
      // вредна: её путь поехал бы через разбор командной строки.
      shell: params.shell && process.platform === 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, params.timeoutMs);

    const done = (): void => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    };
    child.on('error', done);
    child.on('close', done);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
}

/**
 * Минимум окружения, без которого не запустится ни один процесс: путь, оболочка
 * и временный каталог системы. Всё остальное проба добавляет сама.
 */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Первая непустая строка чужого вывода — ровно столько, сколько уместно показать. */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 200) ?? ''
  );
}
