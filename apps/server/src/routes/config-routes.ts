import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, Overview, ProviderDetectResponse } from '@agentdeck/contracts';
import { settingsPatchSchema, importStateSchema } from '../providers/settings-validation.ts';
import type { ServerContext } from '../context.ts';
import { describeProviders } from '../providers/registry.ts';
import { detectProviders } from '../providers/detect.ts';
import {
  readClaudeCredentials,
  validatePanelCredentials,
  savePanelCredentials,
  removePanelCredentials,
  panelCredentialsPath,
} from '../lib/credentials.ts';
import { buildOverview } from '../domains/overview.ts';
import { readAccount } from '../domains/account.ts';
import { forgetOrphanPlatforms, withLegacyConsumers } from '../domains/platform/store.ts';
import { reconcileActivePlatform } from '../domains/platform/activation.ts';
import { reconcileManagedProfiles } from '../domains/platform/apply/profile.ts';
import { rollbackContour, type ContourRollbackDeps } from '../domains/platform/apply/rollback.ts';
import {
  setBackupKeep,
  clampBackupKeep,
  setEncryptSecretBackups,
  setSecretsBasename,
} from '../lib/safe-io.ts';
import { basename } from 'node:path';
import { issuesOf } from '../lib/request-body.ts';
import { codeOf } from '../lib/server-text.ts';
import type { CredentialsLookup } from '../lib/credentials.ts';

/** Источник доступа и причина с кодом — без самого токена. */
function credentialsReply(found: CredentialsLookup) {
  return {
    source: found.source,
    reason: found.reason,
    reasonCode: found.reasonCode,
    reasonParams: found.reasonParams,
  };
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

  /** Зависимости отката контура: живость шлюза ему не нужна — он только возвращает. */
  const rollbackDeps = (): ContourRollbackDeps => ({
    store: ctx.store,
    paths: {
      claudeSettings: ctx.location.paths.settings,
      override: ctx.store.getSettings().claudeDirOverride,
    },
    backupDir: ctx.backupDir,
  });

  app.get('/api/location', () => ctx.location);

  /**
   * Смена каталога конфигурации. Путь обязателен и проверяется до переезда:
   * тело `{}` раньше проходило насквозь — `detectClaudeLocation(undefined)`
   * скатывался к `CLAUDE_CONFIG_DIR`/`~/.claude`, отвечал «всё в порядке», а
   * заодно затирал сохранённый ручной каталог, и панель после перезапуска молча
   * оказывалась в домашнем. Не строка (например число) роняла `.trim()` и
   * возвращала 500 вместо объяснения.
   */
  app.post<{ Body: { path?: unknown } }>('/api/location', (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || !path.trim()) {
      return reply.code(400).send({
        error: 'invalid_path',
        message: 'Укажите путь к каталогу конфигурации.',
        messageCode: 'config-dir-path-required',
      });
    }

    const result = ctx.relocate(path);
    // Запоминаем там, откуда путь прочитает следующий запуск (хранилище
    // каталога старта), а не в `ctx.store` — после переезда это уже хранилище
    // НОВОГО каталога, и панель после перезапуска забывала ручной путь.
    if (result.isValid) ctx.rememberDirOverride(path);
    return result;
  });

  app.get('/api/settings', () => ctx.effectiveSettings());

  /**
   * Провайдеры конфигурации: активный id и список известных с картой статусов
   * возможностей. Дефолт — Claude (всё `ready`, `verified`); прочие объявлены
   * как `experimental` с `planned`/`unsupported` разделами. Клиент по этой карте
   * гейтит навигацию и показывает плейсхолдеры «в разработке».
   */
  app.get('/api/providers', () => describeProviders(ctx.store));

  /**
   * Детект установленных провайдер-CLI (Ф7): по каждому провайдеру — найден ли
   * его бинарь в PATH (`cliInstalled`) и есть ли каталог/файл конфигурации
   * (`configPresent`). Версия НЕ определяется — `--version` не спавним, чтобы
   * исключить зависания на чужих CLI. Ответ — подсказка интерфейсу (бейджи в
   * селекторе, список в онбординге); провайдер сам собой НЕ переключается.
   */
  app.get(
    '/api/providers/detect',
    () => detectProviders(ctx.store) satisfies ProviderDetectResponse,
  );

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
        messageCode: 'settings-invalid',
        issues: issuesOf(parsed.error),
      });
    }

    const { claudeDirOverride, ...patch }: Partial<AppSettings> = parsed.data;
    // Контур, приехавший с панели ДО Т3, поля потребителей не знает, а схема
    // подставила ему пустой список — то есть «никуда не подключён». Возвращаем
    // прежнее поведение по сырому телу, пока ещё видно, было поле или нет.
    if (patch.platforms) {
      patch.platforms = withLegacyConsumers(
        (pre as { platforms?: unknown } | null)?.platforms,
        patch.platforms,
      );
    }
    // Смена каталога через настройки применяется сразу же, а не после перезапуска.
    // Сначала переезд, потом память: отказанный путь не должен осесть в
    // настройках (раньше PATCH с несуществующим каталогом отвечал 200, и
    // настройки называли один каталог, а /api/location — другой). Пустая
    // строка — возврат к автоопределению, ему отказа не бывает.
    if (claudeDirOverride !== undefined) {
      const result = ctx.relocate(claudeDirOverride);
      if (claudeDirOverride && !result.isValid) {
        return reply.code(400).send({
          error: 'invalid_path',
          message: result.problem ?? 'Каталог конфигурации не подходит.',
          ...(result.problemCode
            ? { messageCode: result.problemCode, params: result.problemParams }
            : result.problem
              ? {}
              : { messageCode: 'config-dir-unsuitable' as const }),
        });
      }
      ctx.rememberDirOverride(claudeDirOverride);
    }
    const settings = ctx.store.updateSettings(patch);
    // Глубина ротации копий действует сразу для следующих записей.
    if (patch.backupKeep !== undefined) setBackupKeep(settings.backupKeep);
    // Режим шифрования копий секретов — тоже сразу. Парольную фразу этим не
    // трогаем: включение без фразы просто перестаёт делать копии секретов до
    // её ввода (см. backupEntry), а UI задаёт фразу отдельным запросом.
    if (patch.encryptSecretBackups !== undefined) {
      setEncryptSecretBackups(settings.encryptSecretBackups);
    }
    // Контуры — единственный ключ настроек, за которым тянутся данные ВНЕ
    // настроек: ключ в шифрохранилище и след пробы. Этот маршрут про них не
    // знает, поэтому убирает за собой сразу: контур, исчезнувший из списка,
    // не оставляет ни живого секрета, ни результата проверки.
    if (patch.platforms !== undefined) {
      // Контур, исчезнувший отсюда, уносит и своё применение: иначе конфиги CLI
      // остались бы указывать на маршрут шлюза, которого больше нет, а снять
      // применение было бы уже нечем — маршрут отката спрашивает контур.
      for (const id of forgetOrphanPlatforms(ctx.store, ctx.location.paths.appData)) {
        rollbackContour(rollbackDeps(), id);
      }
      // Тумблеры в пришедшем списке — не решение о том, через какой контур идёт
      // работа: это решение принимает активация, и только она (инвариант 1).
      // Общий патч настроек тумблер трогать вправе, но итог обязан сойтись к
      // активному контуру — иначе шлюз обслуживал бы контур, который панель
      // называет выключенным.
      reconcileActivePlatform(ctx.store);
    }
    // Управляемые профили эндпоинтов — вторая такая же зависимость, и сверка
    // нужна ещё и при смене НАСТРОЕК ШЛЮЗА: сменившийся порт оставил бы в
    // списке профиль с устаревшим адресом, и ассистент панели молча ходил бы
    // в никуда.
    if (patch.platforms !== undefined || patch.platformGateway !== undefined) {
      reconcileManagedProfiles(ctx.store);
    }
    return ctx.effectiveSettings();
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
        messageCode: 'state-import-invalid',
        issues: issuesOf(parsed.error),
      });
    }

    // Тот же возврат прежнего поведения, что и в PATCH: снимок со старой панели
    // поля потребителей не знает, и записанный пустым список отключил бы
    // перенесённый контур от ассистента молча (см. `withLegacyConsumers`).
    const raw = request.body as { settings?: { platforms?: unknown } } | null;
    const incoming = parsed.data.settings?.platforms;
    const state = incoming
      ? {
          ...parsed.data,
          settings: {
            ...parsed.data.settings,
            platforms: withLegacyConsumers(raw?.settings?.platforms, incoming),
          },
        }
      : parsed.data;

    ctx.store.importState(state);
    // Снимок принёс СВОЙ список контуров, а ключи остались от прежнего: те, чьих
    // контуров в снимке нет, стали бы секретами без владельца — панель их больше
    // не показывает, значит и стереть их было бы уже нечем.
    for (const id of forgetOrphanPlatforms(ctx.store, ctx.location.paths.appData)) {
      // Файлы CLI снимок с собой не привёз — они здешние, и правил их здешний
      // контур. Уходящий контур забирает своё применение с собой.
      rollbackContour(rollbackDeps(), id);
    }
    // Снимок принёс тумблеры контуров чужой машины, где активным был другой.
    // Без сведения здесь включённых оказалось бы двое: шлюз обслуживал бы обоих,
    // а карточка одного из них называла бы его неактивным (инвариант 1).
    reconcileActivePlatform(ctx.store);
    // Профили, порождённые контурами: снимок принёс свои и мог не принести
    // прежних. Управляемый профиль без контура указывает на маршрут шлюза,
    // которого нет, — сверка убирает его вместе с выбором ассистента.
    reconcileManagedProfiles(ctx.store);
    // применяем их разом, а не только глубину ротации: иначе включённое в
    // снимке шифрование копий секретов не действовало бы до перезапуска.
    ctx.applyIoSettings();
    return { ok: true, needsRestart: true };
  });

  app.get('/api/overview', (): Overview => buildOverview(ctx.location.paths, ctx.store));

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
      reasonCode: found.reasonCode,
      reasonParams: found.reasonParams,
      hasManual: existsSync(panelCredentialsPath()),
      manualPath: panelCredentialsPath(),
      platform: process.platform,
    };
  });

  app.post<{ Body: { value?: unknown } }>('/api/credentials', (request, reply) => {
    // Не строка (число, объект) роняла `.trim()` пятисоткой — это 400.
    const value = request.body?.value;
    if (typeof value !== 'string') {
      return reply.code(400).send({
        message: 'Пусто: вставьте JSON или ключ API.',
        messageCode: 'credentials-paste-empty',
      });
    }
    const check = validatePanelCredentials(value);
    if (!check.ok) return reply.code(400).send({ message: check.error, ...codeOf(check) });

    savePanelCredentials(value);
    const found = readClaudeCredentials(ctx.location.paths.root);

    return { ...credentialsReply(found), hasManual: true };
  });

  app.delete('/api/credentials', () => {
    removePanelCredentials();
    const found = readClaudeCredentials(ctx.location.paths.root);

    return { ...credentialsReply(found), hasManual: false };
  });
}
