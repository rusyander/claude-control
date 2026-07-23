import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, Overview } from '@claude-control/contracts';
import type { ZodError } from 'zod';
import { settingsPatchSchema, importStateSchema } from '../lib/settings-validation.ts';
import type { ServerContext } from '../context.ts';
import {
  readClaudeCredentials,
  validatePanelCredentials,
  savePanelCredentials,
  removePanelCredentials,
  panelCredentialsPath,
} from '../lib/credentials.ts';
import { readRules } from '../domains/rules.ts';
import { readHooks } from '../domains/hooks.ts';
import { readSkills } from '../domains/skills.ts';
import { readMcpServers } from '../domains/mcp.ts';
import { readPermissions } from '../domains/permissions.ts';
import { readAccount } from '../domains/account.ts';
import { readScripts } from '../domains/scripts.ts';
import {
  setBackupKeep,
  clampBackupKeep,
  setEncryptSecretBackups,
  setSecretsBasename,
} from '../lib/safe-io.ts';
import { basename } from 'node:path';

/** Разбор ошибки zod в список «поле → что не так» — для понятного ответа 400. */
function issuesOf(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Маршруты про само приложение: расположение конфигов, настройки, сводка. */
export function registerConfigRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Глубина ротации копий из настроек — сразу при старте.
  setBackupKeep(ctx.store.getSettings().backupKeep);
  // Шифрование копий секретов: режим — из настроек, basename файла секретов —
  // из расположения. Парольная фраза остаётся пустой до ручного ввода: после
  // перезапуска зашифрованные копии секретов не делаются, пока её не введут.
  setEncryptSecretBackups(ctx.store.getSettings().encryptSecretBackups);
  setSecretsBasename(basename(ctx.location.paths.secretsEnv));
  app.get('/api/location', () => ctx.location);

  app.post<{ Body: { path: string } }>('/api/location', (request) => {
    const result = ctx.relocate(request.body.path);
    if (result.isValid) ctx.store.updateSettings({ claudeDirOverride: request.body.path });
    return result;
  });

  app.get('/api/settings', () => ctx.store.getSettings());

  app.get('/api/account', () => readAccount(ctx.location.paths.mcpConfig));

  /**
   * Сведения о системе. Нужны разделу прав: набор опасных команд и вид путей
   * зависят от операционной системы, и подсказки должны быть под неё.
   */
  app.get('/api/system', () => ({
    platform: process.platform,
    osName:
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    homeDir: homedir(),
    nodeVersion: process.version,
    shell: process.platform === 'win32' ? 'PowerShell / cmd' : (process.env.SHELL ?? 'sh'),
  }));

  app.patch<{ Body: unknown }>('/api/settings', (request, reply) => {
    const raw = request.body;

    // Глубину ротации ужимаем к контрактному [1..100] ДО валидации: значение вне
    // диапазона мы исторически клампим, а не отклоняем (иначе PATCH со 100000
    // заставил бы панель хранить сто тысяч копий, в т.ч. секретов). После клампа
    // число всегда проходит проверку схемы.
    const hasNumericKeep =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { backupKeep?: unknown }).backupKeep === 'number' &&
      Number.isFinite((raw as { backupKeep: number }).backupKeep);
    const pre = hasNumericKeep
      ? {
          ...(raw as Record<string, unknown>),
          backupKeep: clampBackupKeep((raw as { backupKeep: number }).backupKeep),
        }
      : raw;

    // Тело приходит от клиента — доверять ему нельзя: валидируем контрактной
    // (частичной) схемой, кривое отклоняем, неизвестные поля отбрасываем, чтобы
    // мусор не осел в state.json.
    const parsed = settingsPatchSchema.safeParse(pre);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_settings',
        message: 'Настройки не прошли проверку и не сохранены.',
        issues: issuesOf(parsed.error),
      });
    }

    const patch: Partial<AppSettings> = parsed.data;
    const settings = ctx.store.updateSettings(patch);
    // Смена каталога через настройки применяется сразу же, а не после перезапуска.
    if (patch.claudeDirOverride !== undefined) ctx.relocate(patch.claudeDirOverride);
    // Глубина ротации копий действует сразу для следующих записей.
    if (patch.backupKeep !== undefined) setBackupKeep(settings.backupKeep);
    // Режим шифрования копий секретов — тоже сразу. Парольную фразу этим не
    // трогаем: включение без фразы просто перестаёт делать копии секретов до
    // её ввода (см. backupEntry), а UI задаёт фразу отдельным запросом.
    if (patch.encryptSecretBackups !== undefined) {
      setEncryptSecretBackups(settings.encryptSecretBackups);
    }
    return settings;
  });

  // Перенос настроек панели (группы, сценарии, отметки, настройки) — снимок
  // state.json, который раньше переносили только копированием файла руками.
  app.get('/api/settings/export', () => ctx.store.exportState());

  app.post<{ Body: unknown }>('/api/settings/import', (request, reply) => {
    // Снимок приходит с чужой машины — проверяем структуру до записи, иначе
    // испорченный или подсунутый файл осел бы в state.json как есть. Валидные
    // поля берём уже разобранными (без неизвестного мусора).
    const parsed = importStateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_state',
        message: 'Импортируемое состояние не прошло проверку и не применено.',
        issues: issuesOf(parsed.error),
      });
    }

    ctx.store.importState(parsed.data);
    setBackupKeep(ctx.store.getSettings().backupKeep);
    return { ok: true, needsRestart: true };
  });

  app.get('/api/overview', (): Overview => {
    const { paths } = ctx.location;
    const rules = readRules(paths.claudeMd, ctx.store);
    // Обзор отвечает на вопрос «что сейчас действует», поэтому локальные
    // настройки считаются наравне с основными.
    const hooks = readHooks(paths.settings, ctx.store, paths.settingsLocal);
    const skills = readSkills(paths.skills, ctx.store);
    const servers = readMcpServers(paths.mcpConfig, ctx.store);
    const permissions = readPermissions(paths.settings, ctx.store, paths.settingsLocal);
    const scripts = readScripts(
      paths.hooks,
      hooks.map((hook) => hook.scriptPath).filter((path): path is string => Boolean(path)),
    );

    return {
      rules: { total: rules.length, enabled: rules.filter((item) => item.isEnabled).length },
      hooks: {
        total: hooks.length,
        enabled: hooks.filter((item) => item.isEnabled).length,
        // Хук с несуществующим скриптом молча не сработает — такие важно видеть.
        broken: hooks.filter((item) => item.scriptPath && item.scriptExists === false).length,
      },
      skills: { total: skills.length, enabled: skills.filter((item) => item.isEnabled).length },
      scripts: {
        total: scripts.length,
        unused: scripts.filter((item) => !item.isUsed).length,
      },
      mcp: {
        total: servers.length,
        enabled: servers.filter((item) => item.isEnabled).length,
        connected: servers.filter((item) => item.health === 'connected').length,
        failed: servers.filter((item) => item.health === 'failed').length,
      },
      permissions: {
        allow: permissions.filter((item) => item.decision === 'allow').length,
        ask: permissions.filter((item) => item.decision === 'ask').length,
        deny: permissions.filter((item) => item.decision === 'deny').length,
      },
      groups: { total: ctx.store.getGroups().length },
    };
  });
  /**
   * Доступ Claude Code к аккаунту.
   *
   * Наружу отдаётся только источник и причина — сам токен не возвращается
   * никогда: он нужен серверу, а браузеру знать его незачем.
   */
  app.get('/api/credentials', () => {
    const found = readClaudeCredentials(ctx.location.paths.root);

    return {
      source: found.source,
      reason: found.reason,
      hasManual: existsSync(panelCredentialsPath()),
      manualPath: panelCredentialsPath(),
      platform: process.platform,
    };
  });

  app.post<{ Body: { value: string } }>('/api/credentials', (request, reply) => {
    const check = validatePanelCredentials(request.body.value ?? '');
    if (!check.ok) return reply.code(400).send({ message: check.error });

    savePanelCredentials(request.body.value);
    const found = readClaudeCredentials(ctx.location.paths.root);

    return { source: found.source, reason: found.reason, hasManual: true };
  });

  app.delete('/api/credentials', () => {
    removePanelCredentials();
    const found = readClaudeCredentials(ctx.location.paths.root);

    return { source: found.source, reason: found.reason, hasManual: false };
  });
}
