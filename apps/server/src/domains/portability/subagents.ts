import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { splitFrontmatter } from '../skills/frontmatter.ts';

/**
 * Разбор субагентов `~/.claude/agents/*.md` — ЕДИНСТВЕННЫЙ по-настоящему новый
 * парсер партии: читателя субагентов в панели не было ни одного, их видел только
 * `env-transfer` как непрозрачные файлы.
 *
 * Поля шапки взяты с живых файлов установленной сборки 2.1.278
 * (`.agent/cli-import-map.agent.md`): `name`, `description`, `tools` (список
 * через запятую; ключа нет — доступны все инструменты), `disallowedTools`,
 * `model` (в том числе `inherit`) и `omitClaudeMd` (2.1.271).
 *
 * `omitClaudeMd` обязан доехать до канона отдельным полем: субагент с этим
 * флагом работает БЕЗ проектных инструкций, и перенос, в котором флаг потерялся,
 * даёт субагента с контекстом, которого у него не было, — расхождение поведения
 * молча.
 */

export interface ParsedSubagent {
  name: string;
  description: string;
  /** Набор инструментов; `null` — ключа нет, значит доступны все. */
  tools: string[] | null;
  /** Явно запрещённые инструменты; пустой список — ключа нет. */
  disallowedTools: string[];
  model: string | null;
  omitInstructions: boolean;
  body: string;
  filePath: string;
  raw: string;
}

/** Файл субагента не разобран — причина называется, запись не выдумывается. */
export interface SubagentProblem {
  filePath: string;
  detail: string;
  /** Код `detail`; у текста ошибки ОС его нет — он показывается как есть. */
  detailCode?: ServerMessageCode;
}

export interface SubagentScan {
  subagents: ParsedSubagent[];
  problems: SubagentProblem[];
}

/** Больше этого файл субагента не читается. */
const MAX_AGENT_BYTES = 1_000_000;

/**
 * Прочитать каталог субагентов. Каталога нет → пустой результат без проблем: это
 * законное состояние, а не поломка.
 */
export function readSubagentsDir(dir: string): SubagentScan {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    return { subagents: [], problems: [] };
  }

  const subagents: ParsedSubagent[] = [];
  const problems: SubagentProblem[] = [];
  for (const name of names) {
    const filePath = join(dir, name);
    const parsed = readSubagentFile(filePath);
    if ('detail' in parsed) problems.push(parsed);
    else subagents.push(parsed);
  }
  return { subagents, problems };
}

/** Разобрать один файл субагента. Шапки нет или имени нет → проблема с причиной. */
export function readSubagentFile(filePath: string): ParsedSubagent | SubagentProblem {
  let raw: string;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile())
      return {
        filePath,
        detail: 'это не обычный файл',
        detailCode: 'portability-subagent-not-file',
      };
    if (stat.size > MAX_AGENT_BYTES) {
      return {
        filePath,
        detail: 'файл слишком велик для разбора',
        detailCode: 'portability-subagent-too-big',
      };
    }
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    return { filePath, detail: error instanceof Error ? error.message : String(error) };
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  if (Object.keys(frontmatter).length === 0) {
    return {
      filePath,
      detail: 'нет заголовочного блока — это не субагент',
      detailCode: 'portability-subagent-no-frontmatter',
    };
  }

  // Имя субагента — то, чем его зовут. Ключа нет → берём имя файла, как делает и
  // сам CLI; выдумывать здесь нечего, файл именно так и адресуется.
  const name = stringOf(frontmatter.name) ?? basename(filePath).replace(/\.md$/i, '');
  if (!name)
    return {
      filePath,
      detail: 'имя субагента пустое',
      detailCode: 'portability-subagent-empty-name',
    };

  return {
    name,
    description: stringOf(frontmatter.description) ?? '',
    tools: listOf(frontmatter.tools),
    disallowedTools: listOf(frontmatter.disallowedTools) ?? [],
    model: stringOf(frontmatter.model),
    // Флаг читается строго: строка «true» из терпимого разбора шапки тоже
    // значит «да», но любое другое значение — «нет», а не «наверное».
    omitInstructions: frontmatter.omitClaudeMd === true || frontmatter.omitClaudeMd === 'true',
    body: body.trim(),
    filePath,
    raw,
  };
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

/** Список инструментов: `Read, Glob, Write` либо YAML-массив. Ключа нет → `null`. */
function listOf(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim());
  }
  if (typeof value !== 'string') return null;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}
