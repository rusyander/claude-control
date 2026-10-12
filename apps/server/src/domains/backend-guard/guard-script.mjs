/**
 * Защита бэкенда — хук `PreToolUse` проекта и ОДНА копия правил, по которым
 * панель решает то же самое у себя.
 *
 * Файл живёт в двух местах: панель копирует его байт в байт в
 * `<проект>/.claude/hooks/backend-guard.mjs` (оттуда его запускает Claude Code
 * как хук), а сервер панели импортирует отсюда `classify` — для брокера прав
 * своего чата и кнопки «Проверить команду». Две копии правил разъехались бы
 * первой же правкой, поэтому их одна; зависимостей нет — в проекте её
 * исполняет голый Node.
 *
 * Хук не запрещает, а СПРАШИВАЕТ (`permissionDecision: 'ask'`): DROP бывает
 * нужен, и решать это человеку, а не скрипту. Сломался скрипт или файл
 * настроек — молчим: Claude Code считает такой выход не блокирующим, а панель
 * свой вопрос задаёт и без хука.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const GUARD_VERSION = 1;

/** Правила в порядке проверки: первое совпадение — причина вопроса. */
export const GUARD_RULE_IDS = [
  'prod-target',
  'sql-drop',
  'sql-truncate',
  'sql-unbounded',
  'migration-down',
  'infra-change',
  'volume-delete',
];

/** Правила, которые проверяют и аргументы инструментов MCP, а не только команду. */
const MCP_RULES = new Set(['prod-target', 'sql-drop', 'sql-truncate', 'sql-unbounded']);

/** Звено команды не пересекает `;`, `|`, `&` и перевод строки. */
const SAME = String.raw`[^\n;|&]*`;
const re = (source) => new RegExp(source, 'i');

const PATTERNS = {
  'sql-drop': [
    re(
      String.raw`\bdrop\s+(?:materialized\s+view|table|database|schema|index|view|sequence|type|function|procedure|trigger|role|user|extension|owned|domain|collection)\b`,
    ),
    re(String.raw`\balter\s+table\b[^;]*\bdrop\s+(?:column|constraint)\b`),
    re(String.raw`(?:^|[\s;&|(])dropdb\b`),
    re(String.raw`\.dropDatabase\s*\(`),
    re(String.raw`\bdb\.[\w$]+\.drop\s*\(`),
    re(String.raw`\bflush(?:all|db)\b`),
  ],
  // `truncate -s 0 файл` — команда ОС, не SQL: после слова сразу имя, не флаг.
  'sql-truncate': [re(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?["'\x60]?[a-z_]`)],
  'migration-down': [
    re(String.raw`\bmigrat\w*[:_-](?:down|rollback|revert|undo|reset|fresh|drop)\b`),
    re(String.raw`\bmigrate\b${SAME}\s(?:down|drop|force)\b`),
    re(String.raw`\bgoose\b${SAME}\s(?:down|down-to|reset)\b`),
    re(String.raw`\bdbmate\b${SAME}\s(?:down|rollback|drop)\b`),
    re(String.raw`\balembic\b${SAME}\sdowngrade\b`),
    re(String.raw`\bmanage\.py\s+(?:migrate\s+\S+\s+zero|flush|reset_db|sqlflush)\b`),
    re(
      String.raw`\b(?:rails|rake)\s+db:(?:rollback|drop|reset|purge|schema:load|migrate:reset|migrate:down|migrate:redo)\b`,
    ),
    re(String.raw`\bprisma\s+migrate\s+reset\b`),
    re(String.raw`--(?:force-reset|accept-data-loss)\b`),
    re(String.raw`\bflyway\b${SAME}\s(?:clean|undo)\b`),
    re(String.raw`\bsqlx\s+(?:migrate\s+revert|database\s+(?:drop|reset))\b`),
    re(String.raw`\bliquibase\b${SAME}\s(?:rollback[\w-]*|drop-?all)\b`),
    re(String.raw`\bdotnet\s+ef\s+database\s+(?:drop|update\s+0)\b`),
    re(String.raw`\btypeorm\b${SAME}\s(?:migration:revert|schema:drop)\b`),
    re(String.raw`\bsequelize\b${SAME}\sdb:(?:migrate:undo[\w:]*|drop|seed:undo[\w:]*)`),
    re(String.raw`\bartisan\s+(?:migrate:(?:rollback|reset|fresh|refresh)|db:wipe)\b`),
    re(String.raw`\bdiesel\s+(?:migration\s+(?:revert|redo)|database\s+reset)\b`),
    re(String.raw`\batlas\s+schema\s+clean\b`),
  ],
  // Только то, что МЕНЯЕТ окружение: plan, get, describe, logs, diff проходят.
  'infra-change': [
    re(
      String.raw`\b(?:terraform|tofu)\s+(?:-chdir=\S+\s+)?(?:apply|destroy|import|taint|untaint|force-unlock|state\s+(?:rm|mv|push|replace-provider)|workspace\s+delete)\b`,
    ),
    re(
      String.raw`\bpulumi\s+(?:up|destroy|refresh|import|cancel|stack\s+rm|state\s+(?:delete|unprotect))\b`,
    ),
    re(
      String.raw`\bkubectl\b${SAME}?\s(?:delete|apply|create|replace|patch|edit|scale|drain|cordon|uncordon|taint|set|label|annotate|exec|cp|run|expose|autoscale|rollout\s+(?:undo|restart|pause))\b`,
    ),
    re(
      String.raw`\bhelm(?:file)?\b${SAME}?\s(?:install|upgrade|uninstall|delete|rollback|apply|sync|destroy)\b`,
    ),
    re(
      String.raw`\b(?:aws|gcloud|az|doctl|hcloud)\b${SAME}\s(?:delete|remove|terminate|destroy|purge)[\w-]*\b`,
    ),
  ],
  'volume-delete': [
    re(String.raw`\b(?:docker|podman)\s+volume\s+(?:rm|remove|prune)\b`),
    re(String.raw`\b(?:docker|podman)\s+(?:system\s+)?prune\b${SAME}--volumes\b`),
    re(String.raw`\b(?:docker|podman)[\s-]compose\b${SAME}\sdown\b${SAME}\s(?:-v|--volumes)\b`),
    re(String.raw`\b(?:docker|podman)\s+(?:container\s+)?rm\b${SAME}\s-[a-z]*v`),
  ],
};

/** `DELETE`/`UPDATE` без `WHERE` в пределах одного оператора. */
function unbounded(text) {
  for (const statement of text.split(';')) {
    const del = /\bdelete\s+from\s+[\w"'`.]+/i.exec(statement);
    if (del && !/\bwhere\b/i.test(statement)) return del[0];
    const upd = /\bupdate\s+[\w"'`.]+\s+set\b/i.exec(statement);
    if (upd && !/\bwhere\b/i.test(statement)) return upd[0];
  }
  return undefined;
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Метки прода: адрес, IP, имя контекста. Короче трёх знаков — не метка, а шум. */
export function prodMarkersOf(config) {
  const list = Array.isArray(config?.prodMarkers) ? config.prodMarkers : [];
  return list
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function prodHit(text, config) {
  for (const marker of prodMarkersOf(config)) {
    const hit = new RegExp(`(?<![\\w.-])${escapeRe(marker)}(?![\\w-])`, 'i').exec(text);
    if (hit) return hit[0];
  }
  return undefined;
}

const clip = (value) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/**
 * Опасна ли команда. `text` — команда Bash или строки аргументов MCP
 * (`kind: 'mcp'` — тогда проверяются только правила про SQL и прод).
 * Возвращает правило и совпавший кусок или `undefined`.
 */
export function classify(text, config = {}, kind = 'bash') {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : []);
  for (const rule of GUARD_RULE_IDS) {
    if (disabled.has(rule)) continue;
    if (kind === 'mcp' && !MCP_RULES.has(rule)) continue;
    let match;
    if (rule === 'prod-target') match = prodHit(text, config);
    else if (rule === 'sql-unbounded') match = unbounded(text);
    else {
      for (const pattern of PATTERNS[rule]) {
        const hit = pattern.exec(text);
        if (hit) {
          match = hit[0];
          break;
        }
      }
    }
    if (match) return { rule, match: clip(match) };
  }
  return undefined;
}

/** Строки аргументов вызова MCP одним текстом — SQL прячется в любом поле. */
export function mcpText(input) {
  const parts = [];
  const walk = (value, depth) => {
    if (depth > 6 || parts.length > 200) return;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(input, 0);
  return parts.join('\n').slice(0, 20_000);
}

/** Вызов инструмента → что проверять. Не Bash и не MCP — нечего. */
export function classifyCall(toolName, input, config = {}) {
  if (toolName === 'Bash') {
    const command = input && typeof input === 'object' ? input.command : undefined;
    return typeof command === 'string' ? classify(command, config, 'bash') : undefined;
  }
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    return classify(mcpText(input), config, 'mcp');
  }
  return undefined;
}

const REASONS = {
  ru: {
    title: 'Защита бэкенда',
    'prod-target': 'команда обращается к проду',
    'sql-drop': 'снос таблицы, базы или схемы',
    'sql-truncate': 'очистка таблицы',
    'sql-unbounded': 'DELETE или UPDATE без WHERE — все строки',
    'migration-down': 'откат или сброс миграций',
    'infra-change': 'изменение инфраструктуры',
    'volume-delete': 'удаление томов Docker с данными',
  },
  en: {
    title: 'Backend guard',
    'prod-target': 'the command targets production',
    'sql-drop': 'dropping a table, database or schema',
    'sql-truncate': 'emptying a table',
    'sql-unbounded': 'DELETE or UPDATE without WHERE — every row',
    'migration-down': 'rolling back or resetting migrations',
    'infra-change': 'changing infrastructure',
    'volume-delete': 'deleting Docker volumes with data',
  },
};

export function reasonText(hit, lang = 'ru') {
  const texts = REASONS[lang] ?? REASONS.ru;
  return `${texts.title}: ${texts[hit.rule] ?? hit.rule} — ${hit.match}`;
}

function readConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function runAsHook() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw);
      const here = dirname(fileURLToPath(import.meta.url));
      const config = readConfig(join(here, '..', 'backend-guard.json'));
      const hit = classifyCall(event.tool_name, event.tool_input, config);
      if (!hit) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reasonText(hit, config.lang),
          },
        }),
      );
    } catch {
      // Непонятный вход — молчим: вопрос задаст брокер панели, а сломанный
      // хук не должен останавливать каждую команду.
    }
  });
}

const isMain = (() => {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
    const entry = process.argv[1] ? realpathSync(resolve(process.argv[1])).toLowerCase() : '';
    return self === entry;
  } catch {
    return false;
  }
})();

if (isMain) runAsHook();
