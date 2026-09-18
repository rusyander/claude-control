import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProviderCheckStep, ProviderPermissionDraft } from '@agentdeck/contracts';
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
import { serverText } from '../../lib/server-texts.ts';

/**
 * Круги записи «прочитали → записали → прочитали». Настоящие файлы пользователя
 * при этом НЕ ПИШУТСЯ: каждый круг идёт на временной КОПИИ конфигурации, копия
 * удаляется в `finally`.
 */

/** Имя MCP-сервера, которым проверяется круг записи. Живёт только в копии файла. */
const PROBE_SERVER = 'agentdeck-check-probe';

/** Имя переменной окружения для круга записи. Живёт только в копии файла. */
const PROBE_ENV_KEY = 'AGENTDECK_CHECK_PROBE';

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
  if (!target)
    return step('mcp', 'skipped', skipReason(providerId, 'mcp', serverText('checks-section-mcp')));

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
        return step('mcp', 'fail', serverText('checks-mcp-reread-missing'), target.filePath);
      }

      deleteProviderMcpServer(probeTarget, PROBE_SERVER, undefined);
      const after = readProviderMcpServers(probeTarget);
      if (!sameShape(before, after)) {
        return step('mcp', 'fail', serverText('checks-mcp-neighbours'), target.filePath);
      }

      return step(
        'mcp',
        'pass',
        serverText('checks-mcp-ok', { count: before.length }),
        target.filePath,
      );
    },
    (error) =>
      step(
        'mcp',
        'fail',
        serverText('checks-format-rejected', { reason: reason(error) }),
        target.filePath,
      ),
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
    return step(
      'permissions',
      'skipped',
      skipReason(providerId, 'permissions', serverText('checks-section-permissions')),
    );

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
          serverText('checks-permissions-meaning'),
          target.filePath,
        );
      }
      return step('permissions', 'pass', serverText('checks-permissions-ok'), target.filePath);
    },
    (error) =>
      step(
        'permissions',
        'fail',
        serverText('checks-format-rejected', { reason: reason(error) }),
        target.filePath,
      ),
  );
}

/** Круг записи переменных окружения: добавили пробную, убрали, сверили набор. */
export function checkEnv(providerId: string, deps: ProviderCheckDeps): ProviderCheckStep {
  const target = resolveProviderEnvTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target)
    return step('env', 'skipped', skipReason(providerId, 'env', serverText('checks-section-env')));

  return onSandboxCopy(
    target.filePath,
    (sandboxPath) => {
      const probeTarget = { ...target, filePath: sandboxPath, backupName: undefined };
      const before = readProviderEnvVars(probeTarget);

      saveProviderEnvVars(probeTarget, [...before, { key: PROBE_ENV_KEY, value: 'ok' }], undefined);
      const withProbe = readProviderEnvVars(probeTarget);
      if (!withProbe.some((item) => item.key === PROBE_ENV_KEY)) {
        return step('env', 'fail', serverText('checks-env-reread-missing'), target.filePath);
      }

      saveProviderEnvVars(probeTarget, before, undefined);
      const after = readProviderEnvVars(probeTarget);
      if (!sameShape(before, after)) {
        return step('env', 'fail', serverText('checks-env-set-differs'), target.filePath);
      }

      return step(
        'env',
        'pass',
        serverText('checks-env-ok', { count: before.length }),
        target.filePath,
      );
    },
    (error) =>
      step(
        'env',
        'fail',
        serverText('checks-format-rejected', { reason: reason(error) }),
        target.filePath,
      ),
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
    return step('instructions', 'skipped', serverText('checks-instructions-unsupported'));

  if (provider.instructionsRules)
    return step('instructions', 'skipped', serverText('checks-instructions-cursor'));

  if (provider.instructionsList) {
    const target = resolveProviderInstructionsTarget(
      providerSettingsSource(provider.id, deps.claudeDirOverride),
    );
    if (!target)
      return step('instructions', 'skipped', serverText('checks-instructions-list-not-allowed'));

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
            serverText('checks-instructions-list-changed'),
            target.configPath,
          );
        }
        return step(
          'instructions',
          'pass',
          serverText('checks-instructions-list-ok', { count: before.length }),
          target.configPath,
        );
      },
      (error) =>
        step(
          'instructions',
          'fail',
          serverText('checks-format-rejected', { reason: reason(error) }),
          target.configPath,
        ),
    );
  }

  if (!provider.instructionsFile)
    return step('instructions', 'skipped', serverText('checks-instructions-undeclared'));

  const filePath = provider.instructionsFile(deps.claudeDirOverride);
  if (!existsSync(filePath))
    return step(
      'instructions',
      'warn',
      serverText('checks-instructions-file-absent', { path: filePath }),
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
            serverText('checks-instructions-file-ok', { count: text.length }),
            filePath,
          )
        : step('instructions', 'fail', serverText('checks-instructions-file-changed'), filePath);
    },
    (error) =>
      step(
        'instructions',
        'fail',
        serverText('checks-instructions-file-unread', { reason: reason(error) }),
        filePath,
      ),
  );
}
