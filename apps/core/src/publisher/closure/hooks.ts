/**
 * Каталог хуков ядра для копии единицы (05 §Push closure): покопийный `core.hooksPath` смотрит
 * сюда. Каждый хук — короткий sh, который исполняет хук репозитория с тем же именем, найденный В
 * МОМЕНТ запуска (husky, поставленный уже после создания копии, тоже сработает); `pre-push` и
 * `sendemail-validate` (публикация письмом, 06) отказывают, пока задана метка сеанса.
 *
 * Чистый модуль: только текст скриптов. Пишет их `platform/hooks-dir.ts`.
 */

/** Метка дерева сеанса (`session-host/host.ts` `TREE_MARKER`): есть она — git зовёт сеанс. */
export const SESSION_MARKER = 'AGENTDECK_TREE';

/** Хуки, которые публикуют или выпускают текст наружу: под меткой сеанса — отказ. */
export const REFUSING_HOOKS = ['pre-push', 'sendemail-validate'] as const;

/**
 * Хуки клиента, которые копия передаёт репозиторию. `reference-transaction` и
 * `post-index-change` не входят: git зовёт их на каждое обновление ссылки и индекса, лишний
 * запуск sh на Windows — десятки миллисекунд на каждую команду; хук репозитория с этими именами
 * в копии не сработает (названо остатком в отчёте зоны).
 */
export const CHAINED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
] as const;

/**
 * Каталог хуков репозитория в момент запуска, как его нашёл бы git без нашего покопийного слоя:
 * общий конфиг, затем глобальный, затем системный, иначе `<common>/hooks`. Относительный путь —
 * от корня рабочего дерева (там git запускает хуки), `~/` — от дома.
 */
const RESOLVE_REPO_HOOKS = [
  'common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1',
  'dir=$(git config --file "$common/config" --get core.hooksPath)',
  '[ -n "$dir" ] || dir=$(git config --global --get core.hooksPath)',
  '[ -n "$dir" ] || dir=$(git config --system --get core.hooksPath)',
  '[ -n "$dir" ] || dir="$common/hooks"',
  'case "$dir" in "~/"*) dir="$HOME/${dir#\\~/}" ;; esac',
];

/** Текст одного хука; `marker` — имя метки сеанса (тесты подменяют, продукт — `SESSION_MARKER`). */
export function hookScript(name: string, marker: string = SESSION_MARKER): string {
  const refuse = (REFUSING_HOOKS as readonly string[]).includes(name)
    ? [
        `if [ -n "\${${marker}+x}" ]; then`,
        `  echo "agentdeck: ${name} refused inside a session: the core publishes (platform step)" >&2`,
        '  exit 1',
        'fi',
      ]
    : [];
  return [
    '#!/bin/sh',
    `# agentdeck: core hook for the unit copy; chains to the repository's own ${name}.`,
    ...refuse,
    ...RESOLVE_REPO_HOOKS,
    // Как сам git: хук без права исполнения не запускается (и не роняет команду кодом 126).
    `[ -x "$dir/${name}" ] || exit 0`,
    `exec "$dir/${name}" "$@"`,
    '',
  ].join('\n');
}

/** Все скрипты каталога: имя хука → текст. */
export function hookScripts(marker: string = SESSION_MARKER): Record<string, string> {
  return Object.fromEntries(CHAINED_HOOKS.map((name) => [name, hookScript(name, marker)]));
}
