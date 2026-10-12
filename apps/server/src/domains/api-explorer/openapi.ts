import { API_METHODS } from '@agentdeck/contracts/api-explorer';
import type {
  ApiEndpoint,
  ApiMethod,
  ApiParam,
  ApiResponseSpec,
  ApiSchema,
  ApiSpec,
  ApiSpecWarning,
} from '@agentdeck/contracts';
import { isNode, type JsonNode } from './api-explorer.types.ts';
import { createDereffer, exampleFromSchema } from './schema.ts';

/**
 * OpenAPI 3.x и Swagger 2.0 → список эндпоинтов. Читаем только то, что нужно
 * вкладке: параметры пути/запроса/заголовков, тело (JSON — первым) и ответы
 * со схемами. Cookie-параметры и formData Swagger'а — в предупреждения.
 */

const MAX_ENDPOINTS = 2000;
const JSON_TYPE = /[/+]json\b/i;

/** Тип содержимого: JSON — первым, иначе первый объявленный. */
function pickMedia(content: unknown): { type: string; media: JsonNode } | undefined {
  if (!isNode(content)) return undefined;
  const entries = Object.entries(content).filter(([, media]) => isNode(media));
  const json = entries.find(([type]) => JSON_TYPE.test(type) || type === '*/*');
  const chosen = json ?? entries[0];
  return chosen ? { type: chosen[0], media: chosen[1] as JsonNode } : undefined;
}

function firstExample(media: JsonNode): unknown {
  if (media.example !== undefined) return media.example;
  if (isNode(media.examples)) {
    for (const example of Object.values(media.examples)) {
      if (isNode(example) && example.value !== undefined) return example.value;
    }
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readParam(raw: unknown, swagger: boolean): ApiParam | 'body' | 'skip' {
  if (!isNode(raw) || typeof raw.name !== 'string') return 'skip';
  const where = raw.in;
  if (swagger && where === 'body') return 'body';
  if (where !== 'path' && where !== 'query' && where !== 'header') return 'skip';
  // У Swagger 2.0 тип лежит прямо в параметре, у OpenAPI 3 — в `schema`.
  const schema = (isNode(raw.schema) ? raw.schema : swagger ? raw : undefined) as
    ApiSchema | undefined;
  const example = raw.example ?? (schema ? exampleFromSchema(schema) : undefined);
  return {
    name: raw.name,
    in: where,
    required: where === 'path' || raw.required === true,
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    ...(schema ? { schema: pickSchemaFields(schema) } : {}),
    ...(example !== undefined ? { example } : {}),
  };
}

/** Swagger 2.0 кладёт `type`/`format`/`enum` прямо в параметр — берём только поля схемы. */
function pickSchemaFields(schema: ApiSchema): ApiSchema {
  const keep = ['type', 'format', 'enum', 'items', 'default', 'minimum', 'maximum', 'pattern'];
  if (schema.in === undefined) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => keep.includes(key)));
}

function serversOf(doc: JsonNode, swagger: boolean): string[] {
  if (swagger) {
    const base = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/$/, '') : '';
    if (typeof doc.host !== 'string') return base ? [base] : [];
    const schemes = Array.isArray(doc.schemes) ? doc.schemes : [];
    const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'http');
    return [`${String(scheme)}://${doc.host}${base}`];
  }
  if (!Array.isArray(doc.servers)) return [];
  return doc.servers.flatMap((server) => {
    if (!isNode(server) || typeof server.url !== 'string') return [];
    const vars = isNode(server.variables) ? server.variables : {};
    const url = server.url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const variable = vars[name];
      return isNode(variable) && variable.default !== undefined ? String(variable.default) : whole;
    });
    return [url.replace(/\/$/, '')];
  });
}

export function parseOpenApi(raw: JsonNode, sourceId: string): ApiSpec {
  const swagger = typeof raw.swagger === 'string';
  const deref = createDereffer(raw);
  const doc = raw;
  const warnings: ApiSpecWarning[] = [];
  const endpoints: ApiEndpoint[] = [];
  const paths = isNode(doc.paths) ? doc.paths : {};
  const consumes = Array.isArray(doc.consumes) ? doc.consumes.map(String) : [];
  const produces = Array.isArray(doc.produces) ? doc.produces.map(String) : [];
  let skippedCookie = 0;
  let skippedForm = 0;

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref.resolve(rawItem);
    if (!isNode(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of API_METHODS) {
      const op = item[method];
      if (!isNode(op)) continue;
      if (endpoints.length >= MAX_ENDPOINTS) break;
      const params: ApiParam[] = [];
      let body: ApiEndpoint['body'];
      // Свой параметр операции перекрывает общий с тем же именем и местом.
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const ownKeys = new Set(own.filter(isNode).map((param) => `${param.in}:${param.name}`));
      const merged = [
        ...shared.filter((param) => !isNode(param) || !ownKeys.has(`${param.in}:${param.name}`)),
        ...own,
      ];
      for (const rawParam of merged) {
        const param = readParam(rawParam, swagger);
        if (param === 'body' && isNode(rawParam)) {
          const schema = isNode(rawParam.schema) ? (rawParam.schema as ApiSchema) : undefined;
          const types = Array.isArray(op.consumes) ? op.consumes.map(String) : consumes;
          const example = schema ? exampleFromSchema(schema) : undefined;
          body = {
            contentType:
              types.find((type) => JSON_TYPE.test(type)) ?? types[0] ?? 'application/json',
            required: rawParam.required === true,
            ...(schema ? { schema } : {}),
            ...(example !== undefined ? { example } : {}),
          };
        } else if (param === 'skip') {
          if (isNode(rawParam) && rawParam.in === 'cookie') skippedCookie++;
          if (isNode(rawParam) && rawParam.in === 'formData') skippedForm++;
        } else if (param !== 'body') params.push(param);
      }
      // Параметр пути, которого контракт не объявил, всё равно нужен в форме.
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1] ?? '';
        if (!params.some((param) => param.in === 'path' && param.name === name))
          params.push({ name, in: 'path', required: true });
      }
      if (!swagger && isNode(op.requestBody)) {
        const picked = pickMedia(op.requestBody.content);
        if (picked) {
          const schema = isNode(picked.media.schema)
            ? (picked.media.schema as ApiSchema)
            : undefined;
          const example =
            firstExample(picked.media) ?? (schema ? exampleFromSchema(schema) : undefined);
          body = {
            contentType: picked.type === '*/*' ? 'application/json' : picked.type,
            required: op.requestBody.required === true,
            ...(schema ? { schema } : {}),
            ...(example !== undefined ? { example } : {}),
          };
        }
      }
      const responses: ApiResponseSpec[] = [];
      if (isNode(op.responses)) {
        for (const [status, rawResponse] of Object.entries(op.responses)) {
          if (!isNode(rawResponse)) continue;
          const response: ApiResponseSpec = { status };
          if (text(rawResponse.description)) response.description = text(rawResponse.description);
          if (swagger) {
            if (isNode(rawResponse.schema)) {
              response.schema = rawResponse.schema as ApiSchema;
              const types = Array.isArray(op.produces) ? op.produces.map(String) : produces;
              response.contentType =
                types.find((type) => JSON_TYPE.test(type)) ?? types[0] ?? 'application/json';
            }
          } else {
            const picked = pickMedia(rawResponse.content);
            if (picked) {
              response.contentType = picked.type;
              if (isNode(picked.media.schema)) response.schema = picked.media.schema as ApiSchema;
            }
          }
          responses.push(response);
        }
      }
      const upper = method.toUpperCase();
      endpoints.push({
        id: `${upper} ${path}`,
        method: method as ApiMethod,
        path,
        ...(text(op.summary) ? { summary: text(op.summary) } : {}),
        ...(text(op.description) ? { description: text(op.description) } : {}),
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        ...(op.deprecated === true ? { deprecated: true } : {}),
        params,
        ...(body ? { body } : {}),
        responses,
      });
    }
  }

  if (endpoints.length >= MAX_ENDPOINTS) warnings.push({ code: 'truncated', count: MAX_ENDPOINTS });
  if (skippedCookie > 0) warnings.push({ code: 'cookie', count: skippedCookie });
  if (skippedForm > 0) warnings.push({ code: 'form-data', count: skippedForm });
  for (const ref of [...deref.external].slice(0, 5))
    warnings.push({ code: 'external-ref', detail: ref });

  const info = isNode(doc.info) ? doc.info : {};
  return {
    sourceId,
    title: text(info.title) ?? 'API',
    ...(text(info.version) ? { version: text(info.version) } : {}),
    format: swagger ? '2.0' : String(doc.openapi).split('.').slice(0, 2).join('.'),
    servers: serversOf(doc, swagger),
    endpoints,
    warnings,
  };
}
