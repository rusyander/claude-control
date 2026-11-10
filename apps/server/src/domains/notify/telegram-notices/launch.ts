import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { PANEL_LINK_HOST } from '../telegram-answers/compose.ts';

/**
 * Запуск записи `/task` из Telegram (этап 12, W2-D F2): когда предлагать «В работу» и как сказать
 * владельцу, почему запись не стартовала. Причина у ядра — английская проза запускателя или код
 * отказа хода; в Telegram уходит ВСЕГДА русская строка: известная причина — своими словами,
 * незнакомая — общая строка и ссылка на доску, где ядро показывает причину целиком.
 */

/**
 * Запись запускаемая из Telegram: поля оценки несут репозитории (`telegram.repos` настройки ядра
 * копируются в запись при создании). Без них запускатель вернёт её с `launch fields: …repos` —
 * кнопку, которая заведомо не сработает, не показываем.
 */
export function entryLaunchable(entry: BoardEntry | undefined): boolean {
  if (!entry || entry.launch.kind !== 'fields') return false;
  const repos = (entry.launch.fields as { repos?: unknown }).repos;
  return Array.isArray(repos) && repos.length > 0;
}

/** Адрес доски ядра в панели (`/core?view=board`). */
export function boardLink(port = process.env.WEB_PORT ?? '8888'): string {
  return `http://${PANEL_LINK_HOST}:${port}/core?view=board`;
}

/** Строка-ссылка «Открыть доску →» — текстом: адрес loopback Telegram кнопкой не принимает. */
export function boardLinkLine(): string {
  const href = boardLink().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${href}">Открыть доску →</a>`;
}

export const NO_REPOS_HINT =
  'Репозиторий не задан — выберите его на доске или задайте «Репозитории для задач из Telegram» в карточке Telegram панели.';

/** Отказы хода доски по коду (HTTP-ответ ядра) — словами владельца. */
const BY_CODE: Record<string, string> = {
  'move-not-allowed': '«В работу» этой записи сейчас недоступно — она уже не во «Входящих»',
  'unknown-card': 'записи больше нет на доске',
  'telegram-binding': 'из Telegram этот ход не принимается — сделайте его на доске',
  'not-wired': 'доска не подключена в этом ядре',
  'board-unreadable': 'доска ядра не прочиталась',
  'entries-refused': 'ядро не приняло запись',
};

/**
 * Причины запускателя (`conductor/board/{start,launch,proof,route}.ts`) по началу строки и
 * проблемы оценки репозиториев (`conductor/estimate/estimate.ts`) по их хвосту.
 */
const BY_REASON: readonly [RegExp, string][] = [
  [
    /^launch fields:.*\brepos\b/,
    'не задан репозиторий — выберите его на доске или задайте «Репозитории для задач из Telegram» в карточке Telegram',
  ],
  [/^launch fields:/, 'записи не хватает данных для запуска — дополните её на доске'],
  // Проверка репозиториев оценкой (`estimate.ts`): «<путь>: …», проблемы через «; ». Путь наружу
  // не уходит — только где его поправить.
  [
    /: not a git repository(;|$)/,
    'путь репозитория — не git-репозиторий: проверьте «Репозитории для задач из Telegram»',
  ],
  [
    /: base \S+ not found(;|$)/,
    'такой ветки в репозитории нет: проверьте «Репозитории для задач из Telegram»',
  ],
  [/^no start proof/, 'запись не поставлена в очередь человеком'],
  [/^route window holds the start/, 'окно маршрута закрыто — старт подождёт его'],
  [/^the conductor is not running/, 'ядро сейчас не запускает задачи'],
  [/^auto-queue is off/, 'автоочередь источника выключена'],
  [/^config (write|history)/, 'постановка в очередь не подтверждена историей настройки ядра'],
  [/^start failed/, 'старт не удался'],
];

/**
 * Почему не стартовала — одной русской строкой (без префикса «Не запущена»). `undefined` —
 * причина незнакомая: вызывающий пишет общую строку со ссылкой на доску.
 */
export function launchReasonRu(input: { code?: string; reason?: string }): string | undefined {
  const reason = input.reason?.trim() ?? '';
  for (const [pattern, words] of BY_REASON) if (pattern.test(reason)) return words;
  return input.code ? BY_CODE[input.code] : undefined;
}

/** Итог под сообщением `/task`: «↩️ Не запущена: …» или общая строка, если причина незнакомая. */
export function launchRefusedLine(input: { code?: string; reason?: string }): string {
  const words = launchReasonRu(input);
  return words ? `↩️ Не запущена: ${words}` : '↩️ Не запущена — причина на доске';
}
