import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProviderEnvInfo } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderEnvTarget,
  readProviderEnvVars,
  saveProviderEnvVars,
  parseProviderEnvDraft,
  UnrecognizedFormatError,
  EnvKeyNotEncodableError,
  type ProviderEnvTarget,
} from '../domains/provider-env.ts';

/**
 * Универсальный раздел переменных окружения для провайдеров Codex (TOML), Aider
 * (YAML, ключ `set-env` в `~/.aider.conf.yml`) и Gemini (`.env` в `~/.gemini/`).
 * Claude сюда НЕ ходит: его env на собственных богатых роутах `/api/env` — их не
 * трогаем. Клиент выбирает набор роутов по активному провайдеру.
 *
 * Fail-closed: провайдер без `env=ready`/`envConfig` → 400 `section_unsupported`
 * (Claude/Cursor/… сюда попадают под этот отказ). Формат файла не распознан →
 * запись отвечает 422 `format_unrecognized`, чтение отдаёт `readOnly:true`. Имя
 * переменной, непредставимое в формате провайдера (у Aider ключ с `=`, у Gemini
 * имя вне `[A-Za-z_][A-Za-z0-9_]*`), → 400 `invalid_draft` ДО касания файла.
 * Секреты в значениях в лог НЕ пишем.
 */
export function registerProviderEnvRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела переменных окружения.',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message: 'Набор переменных не прошёл проверку: у каждой нужны непустой ключ и значение.',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  } as const;

  const done = (backupPath?: string): { ok: true; backupPath?: string; needsRestart: true } => ({
    ok: true,
    backupPath,
    needsRestart: true,
  });

  const requireTarget = (reply: FastifyReply): ProviderEnvTarget | undefined => {
    const target = resolveProviderEnvTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  app.get('/api/provider-env', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.format,
      filePath: target.filePath,
      cliDetected: target.cliDetected,
    };

    try {
      const vars = readProviderEnvVars(target);
      return { ...base, vars, readOnly: false } satisfies ProviderEnvInfo;
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return {
          ...base,
          vars: [],
          readOnly: true,
          error: error.message,
        } satisfies ProviderEnvInfo;
      }
      throw error;
    }
  });

  app.put<{ Body: unknown }>('/api/provider-env', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const vars = parseProviderEnvDraft(request.body);
    if (!vars) return reply.code(400).send(INVALID_DRAFT);

    try {
      return done(saveProviderEnvVars(target, vars, ctx.backupDir));
    } catch (error) {
      // Имя переменной непредставимо в формате провайдера — это ошибка ввода
      // (400), а не сломанный файл: сообщение объясняет, что именно не так.
      if (error instanceof EnvKeyNotEncodableError) {
        return reply.code(400).send({ error: 'invalid_draft', message: error.message });
      }
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });
}
