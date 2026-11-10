import type { ConfigView, CoreConfig, TelegramSection } from '@agentdeck/contracts/core/config';
import type { TelegramCoreBindingView } from '@agentdeck/contracts/core/telegram-channel';

/**
 * Привязка бота ответов к ядру (этап 12, D29): ответ сервера панели (схема — в контрактах, одна на
 * обе стороны) и запись `telegram.owner`. Сервер считает отпечаток чата бота
 * (`apiBase|botId|chatId|fromId`), но настройку ядра не пишет: строгий `set-config` — только окно
 * панели с числом страницы или телефон.
 */
export type { TelegramCoreBindingView };

export type CoreBindingState = 'needBot' | 'unreachable' | 'bound' | 'unbound';

/** Что показать под переключателем; без бота и без ядра переключатель недоступен. */
export function coreBindingState(view: TelegramCoreBindingView | undefined): CoreBindingState {
  if (!view?.fingerprint) return 'needBot';
  if (!view.reachable) return 'unreachable';
  return view.bound ? 'bound' : 'unbound';
}

/**
 * Документ настройки с новым владельцем: включить — отпечаток чата, выключить — `null` (канал
 * закрыт, раздел остаётся: ядро помнит, что его снимали). Прочие разделы — как в действующем.
 */
export function withTelegramOwner(
  view: ConfigView,
  owner: string | null,
): { doc: CoreConfig; baseDigest: string } {
  // Раздел целиком, кроме владельца: подпись и репозитории `/task` переключатель не стирает.
  return {
    doc: { ...view.doc, telegram: { ...view.doc.telegram, owner } },
    baseDigest: view.digest,
  };
}

export type TelegramRepo = NonNullable<TelegramSection['repos']>[number];

/** Пределы `telegramSectionSchema.repos`: строк, длина пути, длина ветки. */
export const TELEGRAM_REPOS_MAX = 8;
const PATH_MAX = 1000;
const REF_MAX = 300;
/** Разделитель пути и ветки в строке поля — « @ » с пробелами: `git@host` в пути его не задевает. */
const REF_SEPARATOR = ' @ ';
/** Путь, затем последний « @ » и ветка без пробелов (может быть пустой — ветки нет). */
const REF_LINE = /^(.+)\s+@\s*(\S*)$/;

/** Текст поля из настройки: строка на репозиторий, ветка — через « @ ». */
export function reposText(repos: readonly TelegramRepo[] | undefined): string {
  return (repos ?? [])
    .map((repo) => (repo.baseRef ? `${repo.path}${REF_SEPARATOR}${repo.baseRef}` : repo.path))
    .join('\n');
}

export type ReposParse = { repos: TelegramRepo[] } | { error: 'tooMany' | 'tooLong' };

/**
 * Разбор поля: пустые строки и повторы пути пропущены, ветка необязательна. Сверх предела схемы —
 * отказ с причиной: ядро всё равно отбило бы документ, а молча обрезать список нельзя.
 */
export function parseReposText(text: string): ReposParse {
  const repos: TelegramRepo[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const split = REF_LINE.exec(line);
    const path = (split?.[1] ?? line).trim();
    const ref = split?.[2] ?? '';
    if (path.length > PATH_MAX || ref.length > REF_MAX) return { error: 'tooLong' };
    if (repos.some((repo) => repo.path === path)) continue;
    repos.push({ path, baseRef: ref || null });
  }
  return repos.length > TELEGRAM_REPOS_MAX ? { error: 'tooMany' } : { repos };
}

/**
 * Документ настройки с новыми репозиториями `/task`: владелец и подпись — как в действующем (нет
 * раздела — канал закрыт, `owner: null`); пустой список снимает поле — запись ждёт репозиторий на
 * доске.
 */
export function withTelegramRepos(
  view: ConfigView,
  repos: readonly TelegramRepo[],
): { doc: CoreConfig; baseDigest: string } {
  const { repos: _old, ...rest } = view.doc.telegram ?? { owner: null };
  const telegram: TelegramSection = repos.length ? { ...rest, repos: [...repos] } : rest;
  return { doc: { ...view.doc, telegram }, baseDigest: view.digest };
}
