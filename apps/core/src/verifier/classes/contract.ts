/**
 * Класс проверки `contract` (04:130-131) — фасад папки `contract/`: разница схемы контракта
 * между базой и копией (OpenAPI / proto / GraphQL) + пересобранные типы клиента против
 * закоммиченных. Ждать прохода контракта единицам-потребителям — дело очереди (C), не класса.
 */

export { diffOpenApi } from './contract/openapi.ts';
export { diffProto, parseProto, type ProtoShape } from './contract/proto.ts';
export {
  diffGraphql,
  parseGraphql,
  parseGraphqlShape,
  type GqlShape,
  type GqlType,
} from './contract/graphql.ts';
export {
  contractFormat,
  generatedDrift,
  parseSchemaDoc,
  runContract,
  type ContractFormat,
  type ContractInput,
  type GeneratedFile,
} from './contract/run.ts';
