import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { EnvSkip } from '@agentdeck/contracts/portable-env';
import { codexHome } from '../../../providers/catalog/config-dirs.ts';
import { envSkip } from '../canon.ts';
import { readUniversalSections } from '../sections.ts';
import type { ImportResult, Importer } from '../types.ts';

/**
 * Codex → канон.
 *
 * Разделы, которые читает панель: `AGENTS.md`, `config.toml` (MCP, права,
 * переменные). Скиллов, хуков и плагинов у Codex в каталоге возможностей нет —
 * каждый такой раздел приезжает пропуском с причиной, а не пустым списком.
 *
 * ОПОРА НА ПЕРВОИСТОЧНИК: у самого Claude Code есть односторонний импортёр
 * Codex, и его карта соответствий выписана в `.agent/cli-import-map.agent.md`.
 * Наш импортёр ей СЛЕДУЕТ и с ней не спорит:
 *
 *  - ключ, который первоисточник переносить ОТКАЗАЛСЯ (`sandbox_mode`), здесь
 *    тоже уходит в пропуск с той же причиной (`normalize-permissions.ts`), а не
 *    получает выдуманное соответствие;
 *  - разделы, которые первоисточник ЧИТАЕТ, а панель пока нет (`[agents]`,
 *    `[[skills.config]]`, `~/.codex/prompts/*`), НАЗЫВАЮТСЯ пропуском. Молча
 *    отсутствующий раздел — та же ложь о среде, что и выдуманная запись: человек
 *    увидел бы паспорт без своих субагентов и решил, что их нет.
 */
export const importCodexEnvironment: Importer = (deps) => {
  const result = readUniversalSections(deps);
  const config = readCodexConfig();
  const unknownApproval = unrecognizedApproval(config, result.items);

  return {
    // Значение режима не разобрано — режим из паспорта УХОДИТ вместе с ним:
    // адаптер подставил бы умолчание, а умолчание вместо значения из файла — это
    // описанная среда, которой не существует.
    items: unknownApproval.length === 0 ? result.items : withoutMode(result.items),
    skipped: [...result.skipped, ...unreadSections(config), ...unknownApproval],
  };
};

function withoutMode(items: ImportResult['items']): ImportResult['items'] {
  return items.filter((item) => !(item.kind === 'permission' && item.rule.startsWith('mode:')));
}

/** Прочитать `config.toml` целиком. Нечитаемый файл → пусто: о причине скажет тот раздел, который его читает. */
function readCodexConfig(): Record<string, unknown> {
  const configPath = join(codexHome(), 'config.toml');
  if (!existsSync(configPath)) return {};
  try {
    return parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Значение `approval_policy`, которого адаптер панели не знает, в паспорт едет
 * НАЗВАННЫМ ПРОПУСКОМ, а не подменяется умолчанием.
 *
 * Адаптер прав (`provider-permissions/codex.ts`) знает три значения и всё прочее
 * показывает дефолтом — для страницы прав это верно (панель пишет только то, что
 * умеет), но для паспорта среды это ложь: человек увидел бы `on-request` там, где
 * в файле стоит `full-auto`. Набор значений у первоисточника шире
 * (`.agent/cli-import-map.agent.md`: `suggest`, `auto-edit`, `full-auto`,
 * `on-request`, `on-failure`, `never`), и молчать о расхождении нельзя.
 */
function unrecognizedApproval(
  config: Record<string, unknown>,
  items: readonly { kind: string; rule?: string }[],
): EnvSkip[] {
  const raw = config.approval_policy;
  if (typeof raw !== 'string') return [];
  const carried = items.some((item) => item.kind === 'permission' && item.rule === `mode:${raw}`);
  if (carried) return [];

  return [
    envSkip(
      'permission',
      'unsupported_format',
      `approval_policy = ${raw}: значение не разбирается панелью и в паспорт не едет — выдавать вместо него умолчание значило бы описать среду, которой нет`,
    ),
  ];
}

/** Ключи и каталоги, которые односторонний импортёр CLI читает, а панель — ещё нет. */
const UNREAD = [
  {
    key: 'agents',
    kind: 'subagent' as const,
    detail:
      'ключ [agents] в config.toml: субагентов Codex панель пока не разбирает, хотя односторонний импортёр самого CLI их переносит',
  },
  {
    key: 'skills',
    kind: 'skill' as const,
    detail:
      'ключ [[skills.config]] в config.toml: скиллы Codex панель пока не разбирает, хотя односторонний импортёр самого CLI их переносит',
  },
];

function unreadSections(config: Record<string, unknown>): EnvSkip[] {
  const skips: EnvSkip[] = [];

  for (const section of UNREAD) {
    if (config[section.key] !== undefined) {
      skips.push(envSkip(section.kind, 'unsupported_format', section.detail));
    }
  }

  // Каталог подсказок — слэш-команды Codex у первоисточника.
  if (existsSync(join(codexHome(), 'prompts'))) {
    skips.push(
      envSkip(
        'command',
        'unsupported_format',
        'каталог ~/.codex/prompts: команды Codex панель пока не разбирает, хотя односторонний импортёр самого CLI их переносит',
      ),
    );
  }

  return skips;
}
