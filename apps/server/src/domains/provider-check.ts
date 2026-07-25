import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  ModelInfo,
  ProviderCheckLevel,
  ProviderCheckResult,
  ProviderCheckStep,
  ProviderPermissionDraft,
} from '@claude-control/contracts';
import { getProvider, providerSettingsSource } from '../providers/registry.ts';
import { providerCliCandidates } from '../providers/cli.ts';
import { findCliOnPath, pathExists } from '../lib/provider-detect.ts';
import { readTextFile } from '../lib/safe-io.ts';
import { createConfigSandbox } from '../lib/config-sandbox.ts';
import type { ConfigProvider } from '../providers/types.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
} from './provider-mcp.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
  saveProviderPermissions,
  type ProviderPermissionsValues,
} from './provider-permissions.ts';
import {
  resolveProviderEnvTarget,
  readProviderEnvVars,
  saveProviderEnvVars,
} from './provider-env.ts';
import {
  resolveProviderInstructionsTarget,
  readProviderInstructionsEntries,
  saveProviderInstructionsEntries,
} from './provider-instructions.ts';
import { runAssistant, type AssistantRunResult } from './assistant-runner.ts';

/**
 * Проверка провайдера на РЕАЛЬНОЙ машине (IDEA-2).
 *
 * Зачем: у всех провайдеров кроме Claude стоит бейдж «экспериментальный», и он
 * не менялся никогда — даже когда у человека всё давно работает. Форматы у нас
 * собраны по документации и покрыты тестами, но тест доказывает поведение кода,
 * а не то, что на ЭТОЙ машине лежит именно такой файл. Проверка закрывает
 * разрыв: она прогоняет по провайдеру короткий список шагов здесь и сейчас.
 *
 * ГЛАВНОЕ ПРАВИЛО: настоящие файлы пользователя проверка НЕ ПИШЕТ. Круг
 * «прочитали → записали → прочитали» идёт на временной КОПИИ конфигурации
 * (`mkdtemp` во временном каталоге ОС), копия удаляется в `finally`. Иначе
 * проверка портила бы ровно то, ради чего затевалась: у чужих CLI конфиг
 * глобальный, подменить каталог, как у Claude, нельзя.
 *
 * Что именно доказывает круг записи: адаптер разобрал НАСТОЯЩИЙ файл этого
 * человека, пересобрал его и получил ту же семантику. Именно здесь всплывают
 * расхождения версий CLI, ручные правки и незнакомые ключи — то, чего фикстуры
 * в тестах не знают.
 *
 * Запуск ассистента — отдельный шаг и стоит денег/лимитов пользователя, поэтому
 * идёт строго по кнопке и отключается флагом.
 */

/** Что нужно проверке от окружения (всё подменяемо в тестах). */
export interface ProviderCheckDeps {
  appDataDir: string;
  /** Пользовательский каталог конфигурации (его уважает только Claude). */
  claudeDirOverride?: string;
  /** Запускать ли настоящий вызов ассистента. */
  withAssistant: boolean;
  /** Каталог моделей из кэша — чтобы ассистент не ходил в сеть за именем модели. */
  models?: ModelInfo[];
  now?: () => Date;
  detectCli?: (command: string) => boolean;
  exists?: (path: string) => boolean;
  runAssistantImpl?: typeof runAssistant;
  /** Таймаут одного запуска ассистента, мс. */
  assistantTimeoutMs?: number;
}

/** Промпт проверки: ответ короткий, стоит копейки, по нему видно, что канал жив. */
const PROBE_PROMPT = 'Ответь ровно одним словом: готов. Ничего больше не пиши и ничего не делай.';

/** Имя MCP-сервера, которым проверяется круг записи. Живёт только в копии файла. */
const PROBE_SERVER = 'claude-control-check-probe';

/** Имя переменной окружения для круга записи. Живёт только в копии файла. */
const PROBE_ENV_KEY = 'CLAUDE_CONTROL_CHECK_PROBE';

const ASSISTANT_TIMEOUT_MS = 90_000;

/** Стабильное сравнение семантики «до» и «после» круга записи. */
function sameShape(before: unknown, after: unknown): boolean {
  return stableJson(before) === stableJson(after);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return Object.fromEntries(entries.map(([key, item]) => [key, sortDeep(item)]));
}

function step(
  id: ProviderCheckStep['id'],
  status: ProviderCheckStep['status'],
  detail: string,
  filePath?: string,
): ProviderCheckStep {
  return filePath ? { id, status, detail, filePath } : { id, status, detail };
}

/** Текст ошибки адаптера в одну строку — в интерфейс уходит именно он. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Почему круг записи не выполнялся. Два разных случая, и путать их нельзя:
 * у Claude раздел ЕСТЬ, просто живёт на своих богатых маршрутах и универсальным
 * адаптером не обслуживается; у прочих раздела нет вовсе (fail-closed).
 */
function skipReason(
  providerId: string,
  capability: 'mcp' | 'permissions' | 'env',
  title: string,
): string {
  const provider = getProvider(providerId);
  return provider.capabilities[capability] === 'ready'
    ? `${title}: раздел обслуживается собственными маршрутами панели, универсальный круг записи к нему не применяется.`
    : `${title}: у этого провайдера такого раздела нет.`;
}

// --- Шаги --------------------------------------------------------------------

function checkCli(provider: ConfigProvider, deps: ProviderCheckDeps): ProviderCheckStep {
  const found = findCliOnPath(providerCliCandidates(provider), deps.detectCli);
  if (found) return step('cli', 'pass', `Команда ${found} найдена в PATH.`);
  return step(
    'cli',
    'warn',
    'Бинарь CLI в PATH не найден. Разделы конфигурации от этого не ломаются — ограничен только запуск ассистента через CLI.',
  );
}

function checkConfig(provider: ConfigProvider, deps: ProviderCheckDeps): ProviderCheckStep {
  const exists = deps.exists ?? pathExists;
  // Пути считаем в try: у Claude они резолвятся детектом расположения, который
  // на битом override может бросить — проверка от этого падать не должна.
  let paths: string[];
  try {
    paths = provider.configLocations?.(deps.claudeDirOverride) ?? [];
  } catch {
    paths = [];
  }
  if (paths.length === 0)
    return step('config', 'skipped', 'Расположение конфигурации у провайдера не объявлено.');

  const present = paths.filter((path) => exists(path));
  if (present.length === 0)
    return step(
      'config',
      'warn',
      `Ни один из путей конфигурации не найден (${paths.join(', ')}). Обычно они появляются после первого запуска CLI.`,
    );

  // Путь отдельным полем здесь не нужен: он уже перечислен в тексте, а строкой
  // ниже интерфейс показал бы его второй раз.
  return step('config', 'pass', `Конфигурация на месте: ${present.join(', ')}.`);
}

/**
 * Круг записи MCP: читаем список настоящего файла, в КОПИИ добавляем пробный
 * сервер, убеждаемся, что он появился, удаляем его и сверяем, что список вернулся
 * ровно к исходному. Так проверяются обе операции раздела, а не только чтение.
 */
function checkMcp(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderMcpTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return step('mcp', 'skipped', skipReason(providerId, 'mcp', 'MCP-серверы'));

  const sandbox = createConfigSandbox(target.filePath);
  try {
    const probeTarget = { ...target, filePath: sandbox.path, backupName: undefined };
    const before = readProviderMcpServers(probeTarget);

    upsertProviderMcpServer(
      probeTarget,
      null,
      {
        name: PROBE_SERVER,
        transport: 'stdio',
        command: 'echo',
        args: ['ok'],
        env: {},
        headers: {},
      },
      // Копии временного файла не нужны — их некуда откатывать.
      undefined,
    );
    const withProbe = readProviderMcpServers(probeTarget);
    if (!withProbe.some((server) => server.name === PROBE_SERVER)) {
      return step(
        'mcp',
        'fail',
        'Запись пробного сервера прошла, но при перечитывании его нет — формат файла разобран не полностью.',
        target.filePath,
      );
    }

    deleteProviderMcpServer(probeTarget, PROBE_SERVER, undefined);
    const after = readProviderMcpServers(probeTarget);
    if (!sameShape(before, after)) {
      return step(
        'mcp',
        'fail',
        'После добавления и удаления пробного сервера список отличается от исходного — запись меняет соседние записи.',
        target.filePath,
      );
    }

    return step(
      'mcp',
      'pass',
      `Круг чтения-записи сошёлся на копии файла, серверов в нём: ${before.length}.`,
      target.filePath,
    );
  } catch (error) {
    return step('mcp', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath);
  } finally {
    sandbox.dispose();
  }
}

/**
 * Черновик из прочитанных значений — по модели прав провайдера. Явный перенос
 * поля в поле, а не `as`: значения и черновик близки, но не равны (в значениях
 * есть `kind`, `usingDefaults`, сохранённые чужие ключи), и молчаливое
 * приведение однажды отправило бы в файл лишнее.
 */
function permissionsDraftFrom(values: ProviderPermissionsValues): ProviderPermissionDraft {
  switch (values.kind) {
    case 'codex':
      return { approvalPolicy: values.approvalPolicy, sandboxMode: values.sandboxMode };
    case 'gemini':
      return {
        approvalMode: values.approvalMode,
        coreTools: values.coreTools,
        excludeTools: values.excludeTools,
      };
    case 'qwen':
      return {
        approvalMode: values.approvalMode,
        allow: values.allow,
        ask: values.ask,
        deny: values.deny,
      };
    case 'continue':
      return { allow: values.allow, ask: values.ask, exclude: values.exclude };
    case 'goose':
      return { mode: values.mode };
    case 'kimi':
      return { mode: values.mode, rules: values.rules };
    case 'cursor':
      return { allow: values.allow, deny: values.deny };
    default:
      return { entries: values.entries };
  }
}

/**
 * Что сравнивать «до» и «после». `usingDefaults` намеренно выброшен: это не
 * значение прав, а факт «ключей в файле ещё нет». Круг записи их как раз и
 * создаёт, поэтому по этому полю «до» и «после» расходятся законно.
 */
function comparablePermissions(values: ProviderPermissionsValues): unknown {
  const rest: Record<string, unknown> = { ...values };
  delete rest.usingDefaults;
  return rest;
}

/**
 * Круг записи прав: записываем в копию ровно то, что прочитали. Проверка
 * идемпотентности — самый честный вид круга там, где значения нельзя выдумывать:
 * панель не должна подставлять человеку чужой режим аппрувов даже во временный
 * файл, а вот «перезапись собственных значений не меняет смысла» — это ровно тот
 * инвариант, на котором держится раздел.
 */
function checkPermissions(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderPermissionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target)
    return step('permissions', 'skipped', skipReason(providerId, 'permissions', 'Права'));

  const sandbox = createConfigSandbox(target.filePath);
  try {
    const probeTarget = { ...target, filePath: sandbox.path, backupName: undefined };
    const before = readProviderPermissions(probeTarget);
    saveProviderPermissions(probeTarget, permissionsDraftFrom(before), undefined);
    const after = readProviderPermissions(probeTarget);

    if (!sameShape(comparablePermissions(before), comparablePermissions(after))) {
      return step(
        'permissions',
        'fail',
        'Перезапись прочитанных прав изменила их смысл — формат разобран не полностью.',
        target.filePath,
      );
    }
    return step(
      'permissions',
      'pass',
      'Права прочитаны и записаны обратно на копии файла без изменения смысла.',
      target.filePath,
    );
  } catch (error) {
    return step('permissions', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath);
  } finally {
    sandbox.dispose();
  }
}

/** Круг записи переменных окружения: добавили пробную, убрали, сверили набор. */
function checkEnv(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderEnvTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return step('env', 'skipped', skipReason(providerId, 'env', 'Переменные окружения'));

  const sandbox = createConfigSandbox(target.filePath);
  try {
    const probeTarget = { ...target, filePath: sandbox.path, backupName: undefined };
    const before = readProviderEnvVars(probeTarget);

    saveProviderEnvVars(probeTarget, [...before, { key: PROBE_ENV_KEY, value: 'ok' }], undefined);
    const withProbe = readProviderEnvVars(probeTarget);
    if (!withProbe.some((item) => item.key === PROBE_ENV_KEY)) {
      return step(
        'env',
        'fail',
        'Пробная переменная записана, но при перечитывании её нет — формат разобран не полностью.',
        target.filePath,
      );
    }

    saveProviderEnvVars(probeTarget, before, undefined);
    const after = readProviderEnvVars(probeTarget);
    if (!sameShape(before, after)) {
      return step(
        'env',
        'fail',
        'После добавления и удаления пробной переменной набор отличается от исходного.',
        target.filePath,
      );
    }

    return step(
      'env',
      'pass',
      `Круг чтения-записи сошёлся на копии файла, переменных в нём: ${before.length}.`,
      target.filePath,
    );
  } catch (error) {
    return step('env', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath);
  } finally {
    sandbox.dispose();
  }
}

/**
 * Круг записи инструкций. Моделей три, и проверяем ту, что объявлена:
 * один файл — перезапись байт в байт; список ссылок (Aider) — перезапись того же
 * списка; каталог правил (Cursor) — честно пропускаем: там не файл, а дерево
 * `.mdc`, и копировать чужой каталог целиком ради проверки неоправданно.
 */
function checkInstructions(provider: ConfigProvider, deps: ProviderCheckDeps): ProviderCheckStep {
  if (provider.capabilities.globalInstructions !== 'ready')
    return step('instructions', 'skipped', 'Раздел инструкций у этого провайдера не поддержан.');

  if (provider.instructionsRules)
    return step(
      'instructions',
      'skipped',
      'Инструкции Cursor — каталог правил `.mdc`; круг записи по каталогу не выполняется.',
    );

  if (provider.instructionsList) {
    const target = resolveProviderInstructionsTarget(
      providerSettingsSource(provider.id, deps.claudeDirOverride),
    );
    if (!target) return step('instructions', 'skipped', 'Список инструкций не разрешён.');

    const sandbox = createConfigSandbox(target.configPath);
    try {
      const probeTarget = { ...target, configPath: sandbox.path, backupName: undefined };
      const before = readProviderInstructionsEntries(probeTarget);
      saveProviderInstructionsEntries(
        probeTarget,
        before.map((entry) => entry.raw),
        undefined,
      );
      const after = readProviderInstructionsEntries(probeTarget);
      if (before.map((e) => e.raw).join('\n') !== after.map((e) => e.raw).join('\n')) {
        return step(
          'instructions',
          'fail',
          'Перезапись списка ссылок изменила его состав.',
          target.configPath,
        );
      }
      return step(
        'instructions',
        'pass',
        `Список ссылок перезаписан без изменений, записей в нём: ${before.length}.`,
        target.configPath,
      );
    } catch (error) {
      return step(
        'instructions',
        'fail',
        `Формат файла не принят: ${reason(error)}`,
        target.configPath,
      );
    } finally {
      sandbox.dispose();
    }
  }

  if (!provider.instructionsFile)
    return step('instructions', 'skipped', 'Файл инструкций у провайдера не объявлен.');

  const filePath = provider.instructionsFile(deps.claudeDirOverride);
  if (!existsSync(filePath))
    return step(
      'instructions',
      'warn',
      `Файла ${filePath} ещё нет — он появится, когда инструкции будут заданы.`,
      filePath,
    );

  const sandbox = createConfigSandbox(filePath);
  try {
    const text = readTextFile(sandbox.path);
    // Файл инструкций — обычный markdown: круг доказывает, что панель отдаёт и
    // принимает его без потерь (BOM/переводы строк сохраняются как есть).
    writeFileSync(sandbox.path, text);
    const same = readFileSync(sandbox.path, 'utf8') === text;
    return same
      ? step(
          'instructions',
          'pass',
          `Файл инструкций читается и записывается без изменений (${text.length} символов).`,
          filePath,
        )
      : step('instructions', 'fail', 'Перезапись файла инструкций изменила его текст.', filePath);
  } catch (error) {
    return step('instructions', 'fail', `Файл не прочитан: ${reason(error)}`, filePath);
  } finally {
    sandbox.dispose();
  }
}

/** Один настоящий запуск ассистента: доказывает, что канал до модели живой. */
async function checkAssistant(
  provider: ConfigProvider,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckStep> {
  if (!deps.withAssistant)
    return step('assistant', 'skipped', 'Запуск ассистента отключён в этой проверке.');
  if (provider.capabilities.chat !== 'ready')
    return step('assistant', 'skipped', 'Ассистент у этого провайдера не поддержан.');

  const run = deps.runAssistantImpl ?? runAssistant;
  let result: AssistantRunResult;
  try {
    result = await run(provider, [{ role: 'user', content: PROBE_PROMPT }], {
      appDataDir: deps.appDataDir,
      detect: deps.detectCli,
      models: deps.models,
      timeoutMs: deps.assistantTimeoutMs ?? ASSISTANT_TIMEOUT_MS,
    });
  } catch (error) {
    return step('assistant', 'fail', `Запуск не состоялся: ${reason(error)}`);
  }

  if (result.reason === 'no_key_no_cli' || result.reason === 'unsupported')
    return step(
      'assistant',
      'skipped',
      'Запускать нечем: CLI не найден и ключ не задан — это не отказ провайдера.',
    );

  if (!result.ok) return step('assistant', 'fail', result.error ?? 'Ассистент ответил ошибкой.');

  const reply = result.reply.trim();
  if (!reply) return step('assistant', 'fail', 'Ассистент ответил пустым сообщением.');

  return step(
    'assistant',
    'pass',
    `Ассистент ответил через ${result.mode === 'cli' ? 'CLI' : 'API'}: «${reply.slice(0, 80)}».`,
  );
}

// --- Сборка ------------------------------------------------------------------

/**
 * Уровень доверия по шагам.
 *
 * `fail` где угодно — провал. `warn` (нет CLI, конфига ещё нет) — «частично»:
 * работает, но не всё. Пропуск НЕ считается провалом: у провайдера может просто
 * не быть раздела (у Claude MCP и права живут на своих богатых маршрутах), и
 * требовать от него несуществующий круг записи было бы неправдой.
 *
 * А вот ассистент обязан ответить: «проверено» означает «панель сходила до
 * модели этого CLI здесь и получила ответ». Отключил запуск — уровень честно
 * остаётся частичным.
 */
export function levelOf(steps: ProviderCheckStep[]): ProviderCheckLevel {
  if (steps.some((item) => item.status === 'fail')) return 'failed';
  if (steps.some((item) => item.status === 'warn')) return 'partial';
  const assistant = steps.find((item) => item.id === 'assistant');
  return assistant?.status === 'pass' ? 'verified' : 'partial';
}

/** Прогнать проверку одного провайдера. Настоящие файлы пользователя не пишутся. */
export async function checkProvider(
  providerId: string,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckResult> {
  const provider = getProvider(providerId);
  const now = deps.now?.() ?? new Date();

  const steps: ProviderCheckStep[] = [
    checkCli(provider, deps),
    checkConfig(provider, deps),
    checkMcp(provider.id, deps),
    checkPermissions(provider.id, deps),
    checkEnv(provider.id, deps),
    checkInstructions(provider, deps),
    await checkAssistant(provider, deps),
  ];

  return {
    provider: provider.id,
    providerName: provider.name,
    at: now.toISOString(),
    level: levelOf(steps),
    steps,
  };
}
