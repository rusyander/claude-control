import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context.ts';
import { previewConfigWrite, type ConfigPreviewRequest } from '../domains/config-preview.ts';
import { SkillExistsError } from '../domains/skills.ts';
import { normalizeHookDraft } from '../domains/hooks.ts';
import { codeOf } from '../lib/server-text.ts';

/**
 * Предпросмотр записи в конфигурацию Claude Code (правила, скиллы, права, MCP).
 *
 * Отдельный маршрут, а не флаг на маршрутах записи — по той же причине, что у
 * `/api/provider-preview`: забытый флаг однажды означал бы запись там, где её не
 * ждали. Здесь записи нет ни в одной ветке: операция идёт по временной копии
 * файла и по отстранённой копии состояния панели.
 *
 * Черновики проверяет домен (как на записи), схема ниже держит только форму
 * запроса: вид, действие, идентификатор.
 */
const idSchema = z.string().min(1);
const requestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rule'),
    action: z.enum(['save', 'toggle', 'delete']),
    id: idSchema.optional(),
    isEnabled: z.boolean().optional(),
    draft: z
      .object({
        title: z.string().min(1),
        body: z.string(),
        isEnabled: z.boolean().default(true),
        groupIds: z.array(z.string()).default([]),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('skill'),
    action: z.enum(['save', 'delete']),
    id: idSchema.optional(),
    draft: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        body: z.string(),
        groupIds: z.array(z.string()).default([]),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('permission'),
    action: z.enum(['add', 'delete']),
    id: idSchema.optional(),
    draft: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('mcp'),
    action: z.enum(['save', 'delete']),
    id: idSchema.optional(),
    draft: z.unknown().optional(),
  }),
  // Хуки, переменные, инструкции, скрипты и переключатель сущностей (волна A):
  // форму черновика проверяет домен — ровно как на записи.
  z.discriminatedUnion('action', [
    z.object({
      kind: z.literal('hook'),
      action: z.literal('save'),
      id: idSchema.optional(),
      draft: z.record(z.string(), z.unknown()),
    }),
    z.object({
      kind: z.literal('hook'),
      action: z.literal('toggle'),
      id: idSchema,
      isEnabled: z.boolean(),
    }),
    z.object({ kind: z.literal('hook'), action: z.literal('delete'), id: idSchema }),
  ]),
  z.discriminatedUnion('action', [
    z.object({ kind: z.literal('env'), action: z.literal('save'), draft: z.unknown() }),
    z.object({
      kind: z.literal('env'),
      action: z.literal('delete'),
      key: z.string(),
      source: z.string(),
    }),
  ]),
  z.object({ kind: z.literal('instructions'), action: z.literal('save'), content: z.string() }),
  z.discriminatedUnion('action', [
    z.object({
      kind: z.literal('script'),
      action: z.enum(['create', 'save']),
      id: idSchema,
      content: z.string(),
    }),
    z.object({ kind: z.literal('script'), action: z.literal('delete'), id: idSchema }),
  ]),
  z.object({
    kind: z.literal('entity'),
    action: z.literal('toggle'),
    entity: z.enum(['skill', 'mcp', 'permission']),
    id: idSchema,
    isEnabled: z.boolean(),
  }),
]);

type RawRequest = z.infer<typeof requestSchema>;

/** Сырой запрос → вариант домена; не хватает поля для действия — `undefined` (400). */
function toDomainRequest(raw: RawRequest): ConfigPreviewRequest | undefined {
  if (raw.kind === 'hook' && raw.action === 'save') {
    // Та же нормализация, что у маршрута записи: без события хук бессмыслен.
    const draft = normalizeHookDraft(raw.draft);
    return draft ? { ...raw, draft } : undefined;
  }
  if (!('id' in raw) || raw.kind === 'hook' || raw.kind === 'script' || raw.kind === 'entity') {
    return raw as ConfigPreviewRequest;
  }
  const { id } = raw;
  if (raw.kind === 'rule') {
    if (raw.action === 'save')
      return raw.draft ? { kind: 'rule', action: 'save', id, draft: raw.draft } : undefined;
    if (!id) return undefined;
    if (raw.action === 'delete') return { kind: 'rule', action: 'delete', id };
    return raw.isEnabled === undefined
      ? undefined
      : { kind: 'rule', action: 'toggle', id, isEnabled: raw.isEnabled };
  }
  if (raw.kind === 'skill') {
    if (raw.action === 'save')
      return raw.draft ? { kind: 'skill', action: 'save', id, draft: raw.draft } : undefined;
    return id ? { kind: 'skill', action: 'delete', id } : undefined;
  }
  if (raw.kind === 'permission') {
    if (raw.action === 'add') {
      return raw.draft === undefined
        ? undefined
        : { kind: 'permission', action: 'add', draft: raw.draft as never };
    }
    return id ? { kind: 'permission', action: 'delete', id } : undefined;
  }
  if (raw.action === 'save') {
    return raw.draft === undefined
      ? undefined
      : { kind: 'mcp', action: 'save', id, draft: raw.draft };
  }
  return id ? { kind: 'mcp', action: 'delete', id } : undefined;
}

export function registerConfigPreviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: unknown }>('/api/config-preview', (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    const domainRequest = parsed.success ? toDomainRequest(parsed.data) : undefined;
    if (!domainRequest) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: parsed.success
          ? 'Для этого действия не хватает поля (id, draft или isEnabled).'
          : parsed.error.issues.map((issue) => issue.message).join('; '),
        ...(parsed.success ? { messageCode: 'config-preview-field-missing' } : {}),
      });
    }

    try {
      return previewConfigWrite(ctx.location.paths, ctx.store, domainRequest);
    } catch (error) {
      // Коды — те же, что у настоящей записи: предпросмотр не добрее её.
      if (error instanceof SkillExistsError) {
        return reply
          .code(409)
          .send({ error: 'skill_exists', message: error.message, ...codeOf(error) });
      }
      const coded = error as { statusCode?: unknown; code?: unknown; message?: unknown };
      if (typeof coded.statusCode === 'number' && coded.statusCode < 500) {
        return reply.code(coded.statusCode).send({
          error: typeof coded.code === 'string' ? coded.code : 'preview_failed',
          message: String(coded.message),
        });
      }
      throw error;
    }
  });
}
