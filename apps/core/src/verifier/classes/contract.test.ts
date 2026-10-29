import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contractFormat,
  diffGraphql,
  diffOpenApi,
  diffProto,
  runContract,
  type GeneratedFile,
} from './contract.ts';
import { parseYaml } from './yaml-lite.ts';

/**
 * Класс `contract` (04:130-131) на фикстуре OpenAPI (база → копия): каждая ожидаемая разница
 * названа с пометкой «ломает», лишних нет; proto и GraphQL — по таблице; сгенерированные типы
 * против закоммиченных — дрейф назван, генератор упал — вердикта нет.
 */

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/contract/${name}`, import.meta.url), 'utf8');

const brief = (rows: { kind: string; at: string; breaking: boolean }[]) =>
  rows.map((r) => `${r.kind} ${r.at} ${r.breaking ? 'BREAKING' : 'ok'}`).sort();

describe('yaml-lite: the block YAML OpenAPI documents are written in', () => {
  it('maps, lists of maps, flow forms, quoted keys, block scalars, comments', () => {
    expect(
      parseYaml(
        [
          'a: 1',
          "'200':",
          '  b: [x, "y z", 3]',
          '  c: { d: true, e: ~ }',
          'list:',
          '  - name: one # comment',
          '    in: query',
          '  - plain',
          'text: |',
          '  line 1',
          '  # not a comment',
          'folded: >-',
          '  one',
          '  two',
        ].join('\n'),
      ),
    ).toEqual({
      a: 1,
      '200': { b: ['x', 'y z', 3], c: { d: true, e: null } },
      list: [{ name: 'one', in: 'query' }, 'plain'],
      text: 'line 1\n# not a comment\n',
      folded: 'one two',
    });
  });
  it('anchors and tabs refuse with the line named instead of a wrong tree', () => {
    expect(() => parseYaml('a: &x 1\nb: *x')).toThrow(/line 1: anchors/);
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/line 2: tab indent/);
  });
});

describe('P-contract OpenAPI fixture diff (base → copy)', () => {
  it('names every change with its breaking mark and nothing else', async () => {
    const got = await runContract({
      file: 'api/pets.yaml',
      before: fixture('pets.base.yaml'),
      after: fixture('pets.copy.yaml'),
    });
    expect(got).toMatchObject({ value: { format: 'openapi', generatedDrift: null } });
    if (!('value' in got)) return;
    expect(brief(got.value.changes)).toEqual(
      [
        'changed info.title ok',
        'changed info.version ok',
        'changed paths./pets.get.summary ok',
        // Параметр стал обязательным — старый клиент без него получит 400.
        'changed paths./pets.get.parameters.query:limit.required BREAKING',
        // Перестановка параметров разницей не считается (сравнение по in:name).
        'added paths./pets.post.requestBody.content.application/json.schema.required BREAKING',
        'removed paths./pets.post.requestBody.content.application/json.schema.properties.nick ok',
        'added paths./pets.post.requestBody.content.application/json.schema.properties.owner ok',
        'removed paths./pets/{id} BREAKING',
        'added paths./owners ok',
        'changed components.schemas.Pet.properties.id.type BREAKING',
        'added components.schemas.Pet.properties.status.enum BREAKING',
        'added components.schemas.Pet.properties.age ok',
        'changed components.schemas.Pet.description ok',
      ].sort(),
    );
  });
  it('identical documents (JSON vs YAML of the same tree) → no changes', () => {
    const tree = parseYaml(fixture('pets.base.yaml'));
    expect(diffOpenApi(tree, JSON.parse(JSON.stringify(tree)))).toEqual([]);
  });
  it('a new contract (no base) → everything added, nothing breaking', async () => {
    const got = await runContract({
      file: 'api/pets.json',
      before: null,
      after: '{"openapi":"3.1.0","paths":{"/a":{}}}',
    });
    expect(got).toMatchObject({ value: { format: 'openapi' } });
    if ('value' in got) expect(got.value.changes.every((c) => !c.breaking)).toBe(true);
  });
  it('unparseable copy → unknown (no verdict), never "no changes"', async () => {
    expect(
      await runContract({
        file: 'api/pets.json',
        before: '{"openapi":"3"}',
        after: '{"openapi": 3,',
      }),
    ).toMatchObject({ unknown: expect.stringMatching(/^parse api\/pets\.json/) });
  });
  it('format is decided by the document, not the file name', () => {
    expect(contractFormat('x/config.yaml', 'name: x\n')).toBeNull();
    expect(contractFormat('x/api.yml', 'openapi: 3.0.0\n')).toBe('openapi');
    expect(contractFormat('x/a.proto')).toBe('proto');
    expect(contractFormat('x/schema.graphql')).toBe('graphql');
  });
});

describe('proto and GraphQL diff tables', () => {
  it('proto: field removed / type changed / rpc removed / enum value removed break; rename and additions do not', () => {
    const before = `syntax = "proto3";
      message User { string id = 1; string name = 2; int32 age = 3; // c
        enum Role { ADMIN = 0; GUEST = 1; } }
      service Users { rpc Get (GetReq) returns (User); rpc Drop (GetReq) returns (User); }`;
    const after = `syntax = "proto3";
      message User { string id = 1; string full_name = 2; int64 age = 3; repeated string tags = 4;
        enum Role { ADMIN = 0; } }
      message GetReq { string id = 1; }
      service Users { rpc Get (GetReq) returns (stream User); }`;
    expect(brief(diffProto(before, after))).toEqual(
      [
        'changed User.name ok',
        'changed User.age BREAKING',
        'added User.tags ok',
        'removed User.Role.GUEST BREAKING',
        'added GetReq ok',
        'changed Users.Get BREAKING',
        'removed Users.Drop BREAKING',
      ].sort(),
    );
  });
  it('graphql: removed field and type change break; new non-null input field breaks; new output field does not', () => {
    const before = `type Query { user(id: ID!): User }
      type User { id: ID! name: String email: String }
      input NewUser { name: String! nick: String }
      enum Role { ADMIN GUEST }`;
    const after = `"""doc"""
      type Query { user(id: ID!): User users: [User!]! }
      type User { id: String! name: String! }
      input NewUser { name: String nick: String! team: ID! }
      enum Role { ADMIN }`;
    expect(brief(diffGraphql(before, after))).toEqual(
      [
        'added Query.users ok',
        // Выход строже — ок; вход мягче — ок; вход строже и смена типа — ломают.
        'changed User.name ok',
        'changed NewUser.name ok',
        'changed NewUser.nick BREAKING',
        'changed User.id BREAKING',
        'removed User.email BREAKING',
        'added NewUser.team BREAKING',
        'removed Role.GUEST BREAKING',
      ].sort(),
    );
  });
});

describe('contract diff is fail-closed (A2-F06/F07/F12, B2-F05)', () => {
  it('proto: rpc `{}` bodies, gateway options, field `[...]` options and top-level option aggregates keep every later rpc and field visible', () => {
    const before = `syntax = "proto3";
      option java_package = "x.y";
      option (my.file_opt) = { a: 1 b: { c: 2 } };
      service Pets {
        option (svc.opt) = { x: 1 };
        rpc Get (GetReq) returns (Pet) {}
        rpc Delete (GetReq) returns (Pet) { option (google.api.http) = { delete: "/v1/pets/{id}" }; }
        rpc List (GetReq) returns (Pet);
      }
      message Pet { string id = 1 [(validate.rules).string = {min_len: 1}]; string name = 2; int32 age = 3; }
      message GetReq { string id = 1; }`;
    const after = `syntax = "proto3";
      option java_package = "x.y";
      option (my.file_opt) = { a: 1 b: { c: 2 } };
      service Pets {
        option (svc.opt) = { x: 1 };
        rpc Get (GetReq) returns (Pet) {}
      }
      message Pet { string id = 1 [(validate.rules).string = {min_len: 1}]; int64 age = 3; }
      message GetReq { string id = 1; }`;
    expect(brief(diffProto(before, after))).toEqual(
      [
        'removed Pets.Delete BREAKING',
        'removed Pets.List BREAKING',
        'removed Pet.name BREAKING',
        'changed Pet.age BREAKING',
      ].sort(),
    );
  });
  it('proto / graphql: a construct the parser does not know → unknown, never an empty diff', async () => {
    const proto = await runContract({
      file: 'api/pets.proto',
      before: 'syntax = "proto3"; message A { string id = 1; }',
      after: 'syntax = "proto3"; message A { string id = 1; } frobnicate A;',
    });
    expect(proto).toEqual({ unknown: expect.stringMatching(/^proto: unrecognised construct/) });
    const gql = await runContract({
      file: 'api/schema.graphql',
      before: 'type A { id: ID }',
      after: 'typo A { id: ID }',
    });
    expect(gql).toEqual({ unknown: expect.stringMatching(/^graphql: unrecognised construct/) });
  });
  it('graphql: union member, scalar and directive removals break', () => {
    const before = `union R = A | B
      scalar Date
      directive @auth(role: String) on FIELD_DEFINITION | OBJECT
      schema { query: Query }
      type Query { r: R }
      type A { id: ID } type B { id: ID }`;
    const after = `union R = A
      schema { query: Query }
      type Query { r: R }
      type A { id: ID } type B { id: ID }`;
    expect(brief(diffGraphql(before, after))).toEqual(
      ['removed R.B BREAKING', 'removed Date BREAKING', 'removed @auth BREAKING'].sort(),
    );
  });
  it('openapi: request schemas behind $ref (transitively) take request rules; a property named like a doc key is a field', () => {
    const json = (schema: string) => ({
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
    });
    const doc = (s: Record<string, unknown>) => ({
      openapi: '3.0.0',
      paths: {
        '/pets': { post: { requestBody: json('NewPet'), responses: { 200: json('Pet') } } },
      },
      components: { schemas: s },
    });
    const before = doc({
      NewPet: {
        required: ['name'],
        properties: { name: { type: 'string' }, owner: { $ref: '#/components/schemas/Owner' } },
      },
      Owner: { required: ['id'], properties: { id: { type: 'string' } } },
      Pet: {
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['a'] },
        },
      },
    });
    const after = doc({
      NewPet: {
        required: ['name', 'tag'],
        properties: {
          name: { type: 'string' },
          tag: { type: 'string' },
          owner: { $ref: '#/components/schemas/Owner' },
        },
      },
      Owner: { required: ['id', 'email'], properties: { id: { type: 'string' } } },
      Pet: {
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'pet name' },
          tags: { type: 'string' },
          kind: { type: 'string', enum: ['a', 'b'] },
        },
      },
    });
    expect(brief(diffOpenApi(before, after))).toEqual(
      [
        'added components.schemas.NewPet.required BREAKING',
        'added components.schemas.NewPet.properties.tag ok',
        'added components.schemas.Owner.required BREAKING',
        'added components.schemas.Pet.required ok',
        'added components.schemas.Pet.properties.name.description ok',
        'removed components.schemas.Pet.properties.title BREAKING',
        'changed components.schemas.Pet.properties.tags.type BREAKING',
        'removed components.schemas.Pet.properties.tags.items BREAKING',
        'added components.schemas.Pet.properties.kind.enum BREAKING',
      ].sort(),
    );
  });
});

describe('generated client types against the committed ones', () => {
  const committed: Record<string, string> = {
    'web/api/types.ts': 'export type Pet = { id: number };\r\n',
    'web/api/client.ts': 'export const get = 1;\n',
  };
  const read = async (path: string) => committed[path] ?? null;
  const after = fixture('pets.copy.yaml');
  const before = fixture('pets.base.yaml');
  it('regenerated output that differs (EOL ignored) or is missing is named as drift', async () => {
    const regenerate = async () => ({
      value: [
        { path: 'web/api/types.ts', text: 'export type Pet = { id: string };\n' },
        { path: 'web/api/client.ts', text: 'export const get = 1;\r\n' },
        { path: 'web/api/owners.ts', text: 'export {};\n' },
      ] as GeneratedFile[],
    });
    const got = await runContract({
      file: 'api/pets.yaml',
      before,
      after,
      regenerate,
      readCommitted: read,
    });
    expect(got).toMatchObject({
      value: { generatedDrift: ['web/api/types.ts', 'web/api/owners.ts'] },
    });
  });
  it('generator failed → unknown, never "no drift"', async () => {
    const got = await runContract({
      file: 'api/pets.yaml',
      before,
      after,
      regenerate: async () => ({ unknown: 'openapi-typescript exit 1' }),
      readCommitted: read,
    });
    expect(got).toEqual({ unknown: 'regenerate: openapi-typescript exit 1' });
  });
});
