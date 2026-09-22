import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { applyCodexEndpoint, CODEX_ENDPOINT_KEY_ENV } from '../platform/apply/config-files.ts';
import { emitEnvironment } from './emit/index.ts';
import { level } from './fidelity.ts';
import { PROBE_MARKS, probeEnvironment, writeProbeScripts } from './probe-canon.ts';
import type { ProbeScripts } from './probe-canon.ts';
import { PROBE_RECIPES, type ProbeRecipe } from './probe-recipes.ts';
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
  const recipe = PROBE_RECIPES[target.id];
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
  const address = stubAddress(target, recipe);
  if (!address) return refuse('no_stub_endpoint');

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

    const stub = await startProbeStub(scriptFor(recipe, scripts, workdir));
    try {
      const [command, ...prefix] = argv;
      const run = await runTarget({
        command: command ?? '',
        args: [...prefix, ...recipe.args(recipe.commandPrompt)],
        /** Оболочка нужна только настоящему бинарю (.cmd-обёртка на Windows). */
        shell: deps.cliOverride === undefined,
        cwd: workdir,
        env: { ...homeEnv(home), ...address(home, stub.baseUrl) },
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

      return report(observe(stub.requests, promised, existsSync(scripts.mcpAskedPath)));
    } finally {
      await stub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * КУДА цель пойдёт за моделью — и чем ей об этом сказать.
 *
 * Способов ровно два, и выбирает между ними КАТАЛОГ, а не рецепт: переменная
 * окружения (`endpointConfig`) либо кусок собственного конфига цели
 * (`endpointFile`). Отказ `no_stub_endpoint` остаётся для цели, у которой нет ни
 * того, ни другого: пойти в настоящую модель проба не имеет права ни при каких
 * обстоятельствах — это чужие деньги и чужой трафик.
 *
 * Возвращается ФУНКЦИЯ, а не готовый адрес: у файлового способа запись обязана
 * случиться уже после подъёма заглушки — раньше её адреса попросту не
 * существует.
 */
function stubAddress(
  target: ConfigProvider,
  recipe: ProbeRecipe,
): ((home: string, baseUrl: string) => Record<string, string>) | null {
  const vars = target.endpointConfig?.[recipe.apiKind];
  if (vars) {
    return (_home, baseUrl) => ({
      [vars.baseUrlEnv]: baseUrl,
      ...(vars.credentialEnv ? { [vars.credentialEnv]: PROBE_SOURCE } : {}),
      // ИМЯ МОДЕЛИ — тоже часть адреса, и не по аккуратности: живой прогон
      // 22.09.2026 (`qwen 0.24.3`) без него отказывается работать вовсе — «No
      // auth type is selected», ноль запросов и шесть честных «не проверено».
      // Профиль эндпоинта панель пишет человеку тремя переменными, и проба
      // обязана писать те же три: иначе она мерила бы цель, собранную не так,
      // как собирает панель.
      ...(vars.modelEnv ? { [vars.modelEnv]: PROBE_SOURCE } : {}),
    });
  }

  const file = target.endpointFile;
  // Второй формат (`continue-yaml`) сюда не попадает не по забывчивости: у
  // continue нет рецепта пробы, и до этой развилки он не доходит вовсе.
  if (!file || file.apiKind !== recipe.apiKind || file.format !== 'codex-toml') return null;

  return (home, baseUrl) => {
    // Пишет ТОТ ЖЕ код, которым панель пишет контур человеку, а не вторая его
    // копия: разойдись они — проба подтверждала бы адрес, которого панель не
    // пишет, и молчала бы ровно о том дефекте, ради которого заведена. Путь
    // берётся из каталога при подменённом окружении: иначе `codexHome()` указал
    // бы на НАСТОЯЩИЙ дом человека, и проба написала бы туда.
    applyCodexEndpoint(
      withHomeEnv(home, () => file.path()),
      PROBE_SOURCE,
      baseUrl,
      undefined,
      file.wireApi,
    );
    return { [CODEX_ENDPOINT_KEY_ENV]: PROBE_SOURCE };
  };
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
  /**
   * Спрашивала ли цель у пробного MCP-сервера его инструменты. По умолчанию нет:
   * готовому разговору взяться этому следу неоткуда, а умолчание «да» превратило
   * бы непереехавший MCP из красного в «не проверено».
   */
  mcpAsked = false,
): readonly ProbeRow[] {
  return observe(requests, promisedLevels(target, scope), mcpAsked);
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
  const scripts = {
    hookPath: '',
    mcpPath: '',
    skillDir: '',
    forbiddenPath: '',
    envPath: '',
    mcpAskedPath: '',
  };
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
  return withHomeEnv(home, () => {
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
  });
}

/**
 * Выполнить синхронный участок так, будто дом человека — временный каталог
 * пробы. Ограничение на `await` внутри — то самое, о котором сказано выше.
 */
function withHomeEnv<T>(home: string, run: () => T): T {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, homeEnv(home));
    return run();
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
  /**
   * Рабочий каталог прогона: он нужен САМОМУ вызову, а не только запуску. Цель,
   * читающая файл только по абсолютному пути (`qwen`, живой прогон 22.09.2026 —
   * `File path must be absolute`), из одного имени файла вызова не соберёт, а
   * ошибка чтения дала бы по негативу ЗЕЛЁНОЕ право там, где запрет не
   * проверялся вовсе.
   */
  workdir: string,
): (turn: number) => readonly StubBlock[] {
  return (turn) => {
    if (turn > 0) return [{ type: 'text', text: 'Проба завершена.' }];
    return [
      {
        type: 'tool_use',
        id: 'probe_forbidden',
        name: recipe.shellTool.name,
        input: recipe.shellTool.call(`node "${scripts.forbiddenPath}"`, workdir),
      },
      {
        type: 'tool_use',
        id: 'probe_env',
        name: recipe.shellTool.name,
        input: recipe.shellTool.call(`node "${scripts.envPath}"`, workdir),
      },
      {
        type: 'tool_use',
        id: 'probe_denied',
        name: recipe.readTool.name,
        input: recipe.readTool.call(PROBE_MARKS.deniedFile, workdir),
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
  /**
   * Спрашивала ли цель у пробного MCP-сервера его инструменты. Отдельным
   * свидетельством, потому что запрос к модели на этот вопрос не отвечает.
   */
  mcpAsked: boolean,
): ProbeRow[] {
  const first = JSON.stringify(requests[0] ?? {});
  const messages = replies(requests[0] ?? {});
  const tools = JSON.stringify((requests[0] ?? {}).tools ?? []);
  const results = requests.slice(1).map(replies);
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
    // Право судится ПО ОБЕЩАННОМУ УРОВНЮ, и это не поблажка цели.
    //
    // «Нативно» — запрет обязан ОСТАНОВИТЬ чтение, и решает отсутствие
    // содержимого файла. «Текстом» же панель ничего не принуждает и обещает
    // ровно одно: запрет ДОЕДЕТ ДО МОДЕЛИ словами. Мерить его отказом значило бы
    // гарантированно покрасить красным исправный перенос — цель, честно
    // предупреждённая текстом, файл прочитает, потому что принуждать там нечему.
    promisedText('permission', promised)
      ? row(
          'permission',
          first.includes(PROBE_MARKS.deniedFile) ? 'present' : 'absent',
          PROBE_MARKS.deniedFile,
        )
      : row(
          'permission',
          toolsRan
            ? answered.includes(PROBE_MARKS.deniedContent)
              ? 'absent'
              : 'enforced'
            : 'unknown',
          '',
          toolsRan ? null : 'run_failed',
        ),
    // MCP: имя инструмента в списке у модели — лучшее свидетельство, но не
    // единственное возможное. Цель, которая сервер ПОДНЯЛА и список у него
    // ВЗЯЛА, а модели его заранее не назвала, перенос не провалила — она просто
    // объявляет инструменты по запросу (`codex-cli 0.155.1`, живой прогон
    // 22.09.2026). Красный там обвинял бы исправный перенос, зелёный —
    // подтверждал бы ненаблюдавшееся; поэтому строка честно «не проверена» с
    // названной причиной. Сервер, которого не спросили вовсе, — по-прежнему
    // `absent`, то есть красный: это и есть непереехавшая запись.
    tools.includes(PROBE_MARKS.mcpTool)
      ? row('mcpServer', 'present', PROBE_MARKS.mcpTool)
      : mcpAsked
        ? row('mcpServer', 'unknown', PROBE_MARKS.mcpTool, 'target_defers_tools')
        : row('mcpServer', 'absent', PROBE_MARKS.mcpTool),
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

/**
 * Реплики запроса — ПО ИМЕНИ ПОЛЯ, а не по одному заранее выбранному.
 *
 * У клиента Anthropic разговор лежит в `messages`, у ручки `/responses` — в
 * `input`; ровно по этому признаку узнаёт диалект и сама заглушка. Знай
 * наблюдение только одно имя — у второго диалекта ответы инструментов не нашлись
 * бы вовсе, и «вывод так и не появился» дало бы ЗЕЛЁНЫЙ там, где не было даже
 * вызова: наблюдение по негативу без реплик подтверждает что угодно.
 */
function replies(request: Record<string, unknown>): string {
  return JSON.stringify(request.messages ?? request.input ?? []);
}

/** Обещан ли этому слою уровень «текстом» — от него зависит, что вообще мерить. */
function promisedText(layer: ProbeLayer, promised: ReturnType<typeof promisedLevels>): boolean {
  return promised.get(layer)?.level === 'text';
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
