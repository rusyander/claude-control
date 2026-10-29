import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ContractChange, ContractOutcome } from '@agentdeck/contracts/core/records';
import { parseYaml } from '../yaml-lite.ts';
import { parseGraphqlShape, diffGraphql } from './graphql.ts';
import { diffOpenApi } from './openapi.ts';
import { diffProto, parseProto } from './proto.ts';

/**
 * Прогон класса `contract` (04:130-131): формат, разница схемы база → копия, пересобранные типы
 * клиента против закоммиченных. Ломающие помечены — решение «красный или нет» за профилем (C/B).
 * Схема, которую разбор понял не целиком, — `unknown`, а не «изменений нет» (B2-F05).
 */

export type ContractFormat = ContractOutcome['format'];

export function contractFormat(path: string, text?: string): ContractFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.proto')) return 'proto';
  if (lower.endsWith('.graphql') || lower.endsWith('.graphqls') || lower.endsWith('.gql')) {
    return 'graphql';
  }
  if (/\.(json|ya?ml)$/.test(lower)) {
    // OpenAPI узнаём по ключу верхнего уровня, а не по имени: `api.yaml` бывает чем угодно.
    if (text === undefined) return /openapi|swagger/.test(lower) ? 'openapi' : null;
    // Ключ в начале строки (YAML) или после `{`/`,` (JSON в одну строку, в том числе битый).
    return /(^|[{,])\s*["']?(openapi|swagger)["']?\s*:/m.test(text) ? 'openapi' : null;
  }
  return null;
}

export function parseSchemaDoc(path: string, text: string): Fact<unknown> {
  try {
    return { value: path.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text) };
  } catch (error) {
    return { unknown: `parse ${path}: ${(error as Error).message}` };
  }
}

export interface GeneratedFile {
  path: string;
  text: string;
}

export interface ContractInput {
  file: string;
  /** Схема на базе; `null` — контракт новый, всё «добавлено». */
  before: string | null;
  after: string;
  /** Генератор клиента профиля в копии, вывод в стороннюю папку; нет генератора — drift `null`. */
  regenerate?: () => Promise<Fact<GeneratedFile[]>>;
  /** Закоммиченный в копии текст файла; `null` — файла нет. */
  readCommitted?: (path: string) => Promise<string | null>;
}

const eol = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();

export async function generatedDrift(
  regenerate: () => Promise<Fact<GeneratedFile[]>>,
  readCommitted: (path: string) => Promise<string | null>,
): Promise<Fact<string[]>> {
  const fresh = await regenerate();
  if (!('value' in fresh)) {
    return { unknown: `regenerate: ${'unknown' in fresh ? fresh.unknown : 'absent'}` };
  }
  const drift: string[] = [];
  for (const file of fresh.value) {
    const committed = await readCommitted(file.path);
    if (committed === null || eol(committed) !== eol(file.text)) drift.push(file.path);
  }
  return { value: drift };
}

/** Нераспознанное в любой из версий — без вердикта: разница по понятой части была бы неполной. */
function unparsedOf(format: 'proto' | 'graphql', texts: string[]): string | null {
  const parse = format === 'proto' ? parseProto : parseGraphqlShape;
  const left = texts.flatMap((t) => parse(t).unparsed);
  return left.length > 0
    ? `${format}: unrecognised construct: ${left.slice(0, 3).join(' | ')}`
    : null;
}

export async function runContract(input: ContractInput): Promise<Fact<ContractOutcome>> {
  const format = contractFormat(input.file, input.after);
  if (!format) return { unknown: `not a contract schema: ${input.file}` };
  let changes: ContractChange[];
  if (format === 'openapi') {
    const after = parseSchemaDoc(input.file, input.after);
    if (!('value' in after)) return after as Fact<never>;
    const before = input.before === null ? { value: {} } : parseSchemaDoc(input.file, input.before);
    if (!('value' in before)) return before as Fact<never>;
    changes = diffOpenApi(before.value, after.value);
  } else {
    const unparsed = unparsedOf(format, [input.before ?? '', input.after]);
    if (unparsed) return { unknown: unparsed };
    changes =
      format === 'proto'
        ? diffProto(input.before ?? '', input.after)
        : diffGraphql(input.before ?? '', input.after);
  }
  let drift: string[] | null = null;
  if (input.regenerate && input.readCommitted) {
    const got = await generatedDrift(input.regenerate, input.readCommitted);
    // Генератор не отработал — вердикта нет: «дрейфа нет» без прогона генератора было бы ложным зелёным.
    if (!('value' in got)) return got as Fact<never>;
    drift = got.value;
  }
  return { value: { format, file: input.file, changes, generatedDrift: drift } };
}
