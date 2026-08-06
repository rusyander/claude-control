import { readFileSync } from 'node:fs';
import type { PromptGateAction } from '@claude-control/contracts';

/**
 * Сборка скрипта хука.
 *
 * Скрипт получается САМОДОСТАТОЧНЫМ: ядро поиска (`gate-core.mjs`) вставляется
 * в него целиком. Причина простая — хук исполняет Claude Code, а не панель:
 * ссылка на файл внутри панели сломалась бы от переезда папки, а обращение к
 * API панели — от того, что панель не запущена. Хук, падающий вместе с
 * панелью, останавливал бы работу человеку, который про панель уже забыл.
 *
 * Персональных данных в скрипте нет: словарь он читает из `dlp-rules.json` в
 * момент срабатывания. Иначе файл хука (а он попадает в перенос окружения)
 * увозил бы с собой фамилии и телефоны.
 */

export interface GateScriptConfig {
  /** Откуда читать правила — тот же файл, что у прокси. */
  rulesPath: string;
  /** Куда писать журнал; пусто — не писать вовсе. */
  journalPath: string;
  action: PromptGateAction;
}

/** Ядро читается из файла рядом: одна копия логики на прокси и на хук. */
function coreSource(): string {
  const url = new URL('./gate-core.mjs', import.meta.url);
  // `export` снимается: ядро вставляется в тело скрипта, а не импортируется.
  return readFileSync(url, 'utf8').replace(/^export /gm, '');
}

export function buildGateScript(config: GateScriptConfig): string {
  return `// Гейт на промпте — сгенерирован Claude Control.
// Событие: UserPromptSubmit. Смотрит на текст, НАБРАННЫЙ ЧЕЛОВЕКОМ, до отправки.
//
// Чего он не видит принципиально: файлы, которые агент прочитал сам, вывод
// команд, содержимое инструментов, вложения. Всё это уходит в модель мимо хука.
// Замены меткой здесь нет: событие UserPromptSubmit по документации не умеет
// подменять промпт — только остановить отправку (код 2) или добавить сообщение.
//
// Файл можно править руками: панель заметит расхождение и не перезапишет его
// без явной переустановки. Правила берутся из файла ниже — их правят в панели.

import { appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { stdin } from 'node:process';

const CONFIG = ${JSON.stringify(config, null, 2)};

${coreSource()}

/** Журнал общий с прокси. Значений в нём нет — только правило и счётчик. */
function journal(entry) {
  if (!CONFIG.journalPath) return;
  try {
    appendFileSync(CONFIG.journalPath, JSON.stringify(entry) + '\\n', 'utf8');
    if (statSync(CONFIG.journalPath).size > 2000000) {
      const lines = readFileSync(CONFIG.journalPath, 'utf8').split('\\n').filter(Boolean).slice(-500);
      writeFileSync(CONFIG.journalPath, lines.join('\\n') + '\\n', 'utf8');
    }
  } catch {
    // Журнал вспомогательный: его отказ не должен мешать отправке промпта.
  }
}

/** Предупредить, не мешая работе. Пустой stdout — значит промпт идёт как есть. */
function warn(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

let raw = '';
for await (const chunk of stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // Разобрать не вышло — ниже это станет «форму не узнали».
}

// Документированное поле — user_prompt; prompt принимается как запасное.
let prompt;
if (typeof payload.user_prompt === 'string') prompt = payload.user_prompt;
else if (typeof payload.prompt === 'string') prompt = payload.prompt;

if (prompt === undefined) {
  // Форма ввода не узнана. Молчать нельзя (проверки не было), но и блокировать
  // каждый промпт из-за смены формата — значит сломать человеку работу целиком.
  journal({
    at: new Date().toISOString(),
    path: 'hook:UserPromptSubmit',
    apiKind: 'prompt',
    decision: 'passed',
    bytes: raw.length,
    hits: [],
    reason: 'форма ввода хука не узнана — проверка не выполнена',
  });
  warn('Claude Control: гейт не разобрал ввод хука, промпт НЕ проверен.');
}

let rules = [];
try {
  const parsed = JSON.parse(readFileSync(CONFIG.rulesPath, 'utf8'));
  rules = Array.isArray(parsed.rules) ? parsed.rules : [];
} catch {
  // Правил нет или файл испорчен: сказать об этом честно и пропустить. Молчать
  // здесь опаснее — человек считал бы, что проверка работает.
  warn('Claude Control: правила гейта не прочитаны, промпт НЕ проверен.');
}

const matches = scanPrompt(prompt, rules);
if (matches.length === 0) process.exit(0);

const hits = summarize(matches);
const names = [...new Set(hits.map((hit) => hit.ruleName))].join(', ');
// Правило «отклонить» останавливает промпт при любой общей настройке: оно
// означает «этого не должно уходить вовсе».
const blocked = CONFIG.action === 'block' || hits.some((hit) => hit.action === 'block');

journal({
  at: new Date().toISOString(),
  path: 'hook:UserPromptSubmit',
  apiKind: 'prompt',
  decision: blocked ? 'blocked' : 'passed',
  bytes: prompt.length,
  hits,
  reason: names,
});

if (blocked) {
  // Код 2 — единственный документированный способ остановить отправку.
  // В тексте только НАЗВАНИЯ правил: сработавшие значения сюда попасть не могут.
  process.stderr.write(
    'Claude Control: промпт не отправлен — сработали правила защиты данных: ' + names +
      '. Уберите эти данные из текста или отправьте их иначе.',
  );
  process.exit(2);
}

warn('Claude Control: в промпте найдено то, что попадает под правила (' + names + '). Отправлено как есть.');
`;
}
