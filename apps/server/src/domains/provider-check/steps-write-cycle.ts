import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderCheckStep, ProviderPermissionDraft } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { providerSettingsSource } from '../../providers/registry.ts';
import { readTextFile } from '../../lib/safe-io.ts';
import { createConfigSandbox } from '../../lib/config-sandbox.ts';
import { sameShape } from '../../lib/sorted-json.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
} from '../provider-mcp.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
  saveProviderPermissions,
  type ProviderPermissionsValues,
} from '../provider-permissions.ts';
import {
  resolveProviderEnvTarget,
  readProviderEnvVars,
  saveProviderEnvVars,
} from '../provider-env.ts';
import {
  resolveProviderInstructionsTarget,
  readProviderInstructionsEntries,
  saveProviderInstructionsEntries,
} from '../provider-instructions.ts';
import { reason, skipReason, step } from './step.ts';
import type { ProviderCheckDeps } from './types.ts';

/**
 * Круги записи «прочитали → записали → прочитали». Настоящие файлы пользователя
 * при этом НЕ ПИШУТСЯ: каждый круг идёт на временной КОПИИ конфигурации, копия
 * удаляется в `finally`.
 */

/** Имя MCP-сервера, которым проверяется круг записи. Живёт только в копии файла. */
const PROBE_SERVER = 'claude-control-check-probe';

/** Имя переменной окружения для круга записи. Живёт только в копии файла. */
const PROBE_ENV_KEY = 'CLAUDE_CONTROL_CHECK_PROBE';

/** Прогнать круг на копии файла: копия создаётся, отдаётся шагу и всегда удаляется. */
function onSandboxCopy(
  filePath: string,
  run: (sandboxPath: string) => ProviderCheckStep,
  onError: (error: unknown) => ProviderCheckStep,
): ProviderCheckStep {
  const sandbox = createConfigSandbox(filePath);
  try {
    return run(sandbox.path);
  } catch (error) {
    return onError(error);
  } finally {
    sandbox.dispose();
  }
}

/**
 * Круг записи MCP: читаем список настоящего файла, в КОПИИ добавляем пробный
 * сервер, убеждаемся, что он появился, удаляем его и сверяем, что список вернулся
 * ровно к исходному. Так проверяются обе операции раздела, а не только чтение.
 */
export function checkMcp(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderMcpTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return step('mcp', 'skipped', skipReason(providerId, 'mcp', 'MCP-серверы'));

  return onSandboxCopy(
    target.filePath,
    (sandboxPath) => {
      const probeTarget = { ...target, filePath: sandboxPath, backupName: undefined };
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
        // allowOverwrite: самопроверка пишет в КОПИЮ и проверяет круг записи. Если
        // сервер с пробным именем в конфигурации уже есть, отказ по конфликту
        // выдал бы «формат сломан» там, где всё исправно.
        { allowOverwrite: true },
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
    },
    (error) => step('mcp', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath),
  );
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
export function checkPermissions(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderPermissionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target)
    return step('permissions', 'skipped', skipReason(providerId, 'permissions', 'Права'));

  return onSandboxCopy(
    target.filePath,
    (sandboxPath) => {
      const probeTarget = { ...target, filePath: sandboxPath, backupName: undefined };
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
    },
    (error) =>
      step('permissions', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath),
  );
}

/** Круг записи переменных окружения: добавили пробную, убрали, сверили набор. */
export function checkEnv(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderEnvTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return step('env', 'skipped', skipReason(providerId, 'env', 'Переменные окружения'));

  return onSandboxCopy(
    target.filePath,
    (sandboxPath) => {
      const probeTarget = { ...target, filePath: sandboxPath, backupName: undefined };
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
    },
    (error) => step('env', 'fail', `Формат файла не принят: ${reason(error)}`, target.filePath),
  );
}

/**
 * Круг записи инструкций. Моделей три, и проверяем ту, что объявлена:
 * один файл — перезапись байт в байт; список ссылок (Aider) — перезапись того же
 * списка; каталог правил (Cursor) — честно пропускаем: там не файл, а дерево
 * `.mdc`, и копировать чужой каталог целиком ради проверки неоправданно.
 */
export function checkInstructions(
  provider: ConfigProvider,
  deps: ProviderCheckDeps,
): ProviderCheckStep {
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

    return onSandboxCopy(
      target.configPath,
      (sandboxPath) => {
        const probeTarget = { ...target, configPath: sandboxPath, backupName: undefined };
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
      },
      (error) =>
        step('instructions', 'fail', `Формат файла не принят: ${reason(error)}`, target.configPath),
    );
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

  return onSandboxCopy(
    filePath,
    (sandboxPath) => {
      const text = readTextFile(sandboxPath);
      // Файл инструкций — обычный markdown: круг доказывает, что панель отдаёт и
      // принимает его без потерь (BOM/переводы строк сохраняются как есть).
      writeFileSync(sandboxPath, text);
      const same = readFileSync(sandboxPath, 'utf8') === text;
      return same
        ? step(
            'instructions',
            'pass',
            `Файл инструкций читается и записывается без изменений (${text.length} символов).`,
            filePath,
          )
        : step('instructions', 'fail', 'Перезапись файла инструкций изменила его текст.', filePath);
    },
    (error) => step('instructions', 'fail', `Файл не прочитан: ${reason(error)}`, filePath),
  );
}
