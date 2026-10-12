import { describe, expect, it } from 'vitest';
import type { ApiEndpoint } from '@agentdeck/contracts';
import { parseSpecText } from './load.ts';
import { checkResponse, validateValue } from './validate.ts';

/**
 * Разбор контракта и сверка ответа — на настоящих формах документов: OpenAPI
 * 3.0 YAML со ссылками и циклом, Swagger 2.0 JSON, коллекция Postman v2.1.
 */

const OAS3 = `
openapi: 3.0.3
info: { title: Shop, version: '1.2' }
servers:
  - url: 'http://localhost:{port}/api'
    variables: { port: { default: '8080' } }
paths:
  /users/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: integer } }
    get:
      tags: [users]
      summary: One user
      parameters:
        - { name: verbose, in: query, schema: { type: boolean } }
        - { name: session, in: cookie, schema: { type: string } }
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { $ref: '#/components/schemas/User' } } }
        '404': { description: missing }
  /users:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewUser' }
      responses:
        '2XX':
          content: { application/json: { schema: { $ref: '#/components/schemas/User' } } }
        default:
          content: { application/json: { schema: { $ref: 'errors.yaml#/Error' } } }
components:
  schemas:
    NewUser:
      type: object
      required: [email]
      properties:
        email: { type: string, format: email }
        role: { type: string, enum: [admin, user] }
        id: { type: integer, readOnly: true }
    User:
      allOf:
        - $ref: '#/components/schemas/NewUser'
        - type: object
          required: [id]
          properties:
            id: { type: integer }
            manager: { $ref: '#/components/schemas/User' }
            createdAt: { type: string, format: date-time, nullable: true }
`;

const SWAGGER = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy' },
  host: 'api.example.com',
  basePath: '/v1/',
  schemes: ['http', 'https'],
  consumes: ['application/json'],
  paths: {
    '/pets': {
      post: {
        parameters: [
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } },
          { name: 'X-Trace', in: 'header', type: 'string' },
          { name: 'file', in: 'formData', type: 'file' },
        ],
        responses: { 201: { schema: { $ref: '#/definitions/Pet' } } },
      },
    },
  },
  definitions: {
    Pet: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', example: 'Rex' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
});

const POSTMAN = JSON.stringify({
  info: {
    _postman_id: 'x',
    name: 'Shop calls',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'host', value: 'http://localhost:3000' },
    { key: 'token', value: 'abc' },
  ],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            url: { raw: '{{host}}/users/:id?verbose=true', variable: [{ key: 'id', value: '7' }] },
          },
        },
        {
          name: 'Create user',
          request: {
            method: 'POST',
            header: [{ key: 'X-Off', value: '1', disabled: true }],
            body: {
              mode: 'raw',
              raw: '{"email":"{{mail}}"}',
              options: { raw: { language: 'json' } },
            },
            url: '{{host}}/users',
          },
        },
        {
          name: 'Create user again',
          request: { method: 'POST', url: '{{host}}/users', auth: { type: 'oauth2' } },
        },
        {
          name: 'Upload',
          request: {
            method: 'PUT',
            url: '{{base}}/files',
            body: { mode: 'formdata', formdata: [] },
          },
        },
      ],
    },
  ],
});

const byId = (endpoints: ApiEndpoint[], id: string): ApiEndpoint => {
  const found = endpoints.find((endpoint) => endpoint.id === id);
  if (!found) throw new Error(`no ${id}: ${endpoints.map((item) => item.id).join(', ')}`);
  return found;
};

describe('OpenAPI 3', () => {
  const spec = parseSpecText(OAS3, 'file:openapi.yaml');

  it('заголовок, версия, сервер с подставленной переменной', () => {
    expect(spec).toMatchObject({ title: 'Shop', version: '1.2', format: '3.0' });
    expect(spec.servers).toEqual(['http://localhost:8080/api']);
  });

  it('параметры пути из общего списка, cookie — в предупреждения', () => {
    const get = byId(spec.endpoints, 'GET /users/{id}');
    expect(get.params.map((param) => `${param.in}:${param.name}:${param.required}`)).toEqual([
      'path:id:true',
      'query:verbose:false',
    ]);
    expect(get.tags).toEqual(['users']);
    expect(spec.warnings).toContainEqual({ code: 'cookie', count: 1 });
  });

  it('ссылки подставлены, цикл обрезан, внешняя ссылка — предупреждение', () => {
    const get = byId(spec.endpoints, 'GET /users/{id}');
    const schema = get.responses.find((response) => response.status === '200')?.schema;
    expect(JSON.stringify(schema)).toContain('"$circular":"User"');
    expect(JSON.stringify(schema)).not.toContain('"$ref"');
    expect(spec.warnings).toContainEqual({ code: 'external-ref', detail: 'errors.yaml#/Error' });
  });

  it('пример тела из схемы: без readOnly-поля, enum — первым значением', () => {
    const post = byId(spec.endpoints, 'POST /users');
    expect(post.body).toMatchObject({ contentType: 'application/json', required: true });
    expect(post.body?.example).toEqual({ email: 'user@example.com', role: 'admin' });
  });
});

describe('Swagger 2.0', () => {
  const spec = parseSpecText(SWAGGER, 'file:swagger.json');

  it('сервер из host + basePath, https предпочтён', () => {
    expect(spec.format).toBe('2.0');
    expect(spec.servers).toEqual(['https://api.example.com/v1']);
  });

  it('параметр body — тело, header — параметр, formData — предупреждение', () => {
    const post = byId(spec.endpoints, 'POST /pets');
    expect(post.body?.example).toEqual({ name: 'Rex', tags: ['string'] });
    expect(post.params).toEqual([
      expect.objectContaining({ name: 'X-Trace', in: 'header', schema: { type: 'string' } }),
    ]);
    expect(spec.warnings).toContainEqual({ code: 'form-data', count: 1 });
    expect(post.responses[0]).toMatchObject({ status: '201', contentType: 'application/json' });
  });
});

describe('Postman', () => {
  const spec = parseSpecText(POSTMAN, 'postman:1');

  it('папка — тег, :id — параметр пути, сервер из переменной', () => {
    expect(spec).toMatchObject({
      format: 'postman',
      title: 'Shop calls',
      servers: ['http://localhost:3000'],
    });
    const get = byId(spec.endpoints, 'GET /users/{id}');
    expect(get.tags).toEqual(['Users']);
    expect(get.params).toEqual([
      { name: 'id', in: 'path', required: true, example: '7' },
      { name: 'verbose', in: 'query', required: false, example: 'true' },
    ]);
  });

  it('авторизация коллекции — заголовком, выключенный заголовок не переносится', () => {
    const post = byId(spec.endpoints, 'POST /users');
    expect(post.preset?.headers).toEqual([
      ['Authorization', 'Bearer abc'],
      ['Content-Type', 'application/json'],
    ]);
    // Неизвестная переменная остаётся как была — человек увидит и поправит.
    expect(post.preset?.body).toBe('{"email":"{{mail}}"}');
  });

  it('повтор запроса различён, oauth2 и form-data — предупреждения', () => {
    expect(byId(spec.endpoints, 'POST /users #2').summary).toBe('Create user again');
    expect(spec.warnings).toContainEqual({ code: 'postman-auth', detail: 'oauth2' });
    expect(spec.warnings).toContainEqual({ code: 'postman-body', count: 1 });
    // `{{base}}` не задан — серверов с ним нет, путь остался чистым.
    expect(byId(spec.endpoints, 'PUT /files').path).toBe('/files');
  });
});

describe('не контракт', () => {
  it('битый YAML — unreadable, чужой JSON — not-a-spec', () => {
    expect(() => parseSpecText('a: [', 'x')).toThrow(
      expect.objectContaining({ kind: 'unreadable' }),
    );
    expect(() => parseSpecText('{"name":"pkg"}', 'x')).toThrow(
      expect.objectContaining({ kind: 'not-a-spec' }),
    );
  });
});

describe('сверка ответа', () => {
  const spec = parseSpecText(OAS3, 'file:openapi.yaml');
  const get = byId(spec.endpoints, 'GET /users/{id}');
  const post = byId(spec.endpoints, 'POST /users');
  const json = 'application/json; charset=utf-8';

  it('совпало — ok, с каким ответом сверяли', () => {
    const body = JSON.stringify({ id: 1, email: 'a@b.c', createdAt: null, manager: { id: 2 } });
    expect(checkResponse(get, 200, json, body)).toEqual({
      verdict: 'ok',
      against: '200',
      issues: [],
    });
  });

  it('расхождения с путями: тип, обязательное поле, enum, формат', () => {
    const body = JSON.stringify({ id: '1', role: 'root', email: 'nope', createdAt: 'вчера' });
    const check = checkResponse(get, 200, json, body);
    expect(check?.verdict).toBe('mismatch');
    expect(check?.issues).toEqual(
      expect.arrayContaining([
        { path: '$.email', kind: 'format', expected: 'email', actual: '"nope"' },
        { path: '$.role', kind: 'enum', expected: '"admin", "user"', actual: '"root"' },
        { path: '$.id', kind: 'type', expected: 'integer', actual: 'string' },
        { path: '$.createdAt', kind: 'format', expected: 'date-time', actual: '"вчера"' },
      ]),
    );
    const missing = checkResponse(get, 200, json, '{"email":"a@b.c"}');
    expect(missing?.issues).toEqual([{ path: '$.id', kind: 'required', expected: 'id' }]);
  });

  it('диапазон 2XX, неописанный код, нет схемы, не JSON', () => {
    expect(checkResponse(post, 201, json, '{"id":1,"email":"a@b.c"}')).toMatchObject({
      verdict: 'ok',
      against: '2XX',
    });
    expect(checkResponse(get, 500, json, '{}')).toEqual({
      verdict: 'undocumented-status',
      issues: [],
    });
    expect(checkResponse(get, 404, 'text/plain', 'no')).toMatchObject({ verdict: 'no-schema' });
    expect(checkResponse(get, 200, 'text/html', '<html>')).toMatchObject({ verdict: 'not-json' });
    // default со ссылкой на другой файл — схема не разобрана, ругать не по чему.
    expect(checkResponse(post, 500, json, '{"x":1}')).toMatchObject({
      verdict: 'ok',
      against: 'default',
    });
  });

  it('у запроса из Postman ответов нет — сверки нет', () => {
    const postman = parseSpecText(POSTMAN, 'postman:1');
    expect(checkResponse(byId(postman.endpoints, 'POST /users'), 200, json, '{}')).toBeUndefined();
  });

  it('лишнее поле при additionalProperties:false, элементы массива по индексу', () => {
    const swagger = parseSpecText(SWAGGER, 'file:swagger.json');
    const pet = byId(swagger.endpoints, 'POST /pets');
    const check = checkResponse(pet, 201, json, '{"name":"a","tags":["x",3],"age":2}');
    expect(check?.issues).toEqual([
      { path: '$.tags[1]', kind: 'type', expected: 'string', actual: 'integer' },
      { path: '$.age', kind: 'additional', actual: '2' },
    ]);
  });

  it('oneOf: ни один вариант — расхождение; тип 3.1 списком с null', () => {
    const oneOf = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(validateValue(oneOf, 3)).toEqual([]);
    expect(validateValue(oneOf, true)).toEqual([
      { path: '$', kind: 'one-of', expected: '2', actual: 'boolean' },
    ]);
    expect(validateValue({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(validateValue({ type: 'number' }, 3)).toEqual([]);
    expect(validateValue({ type: 'integer' }, 3.5)).toHaveLength(1);
  });
});
