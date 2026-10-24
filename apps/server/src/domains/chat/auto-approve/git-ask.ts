import { withPowerShellTwins } from './powershell-twins.ts';

/**
 * Правила `ask` для авторежима CLI одиночного чата (ревью 23.10, L2).
 *
 * В авторежиме (`--permission-mode auto`) CLI зовёт брокер прав панели только
 * для вызовов, задетых правилом `ask`; остальное решает его классификатор, и
 * `gitDestroys` маршрута прав (удаление данных git и слияние — человеку и в
 * одиночном чате, решение владельца 23.10) до такого вызова не доходил вовсе.
 * У группы это закрыто `GROUP_DANGER_ASK` (весь git к брокеру); одиночному чату
 * весь git к брокеру не нужен — его обычный git остаётся классификатору, а к
 * брокеру идут только формы, где разбор может найти удаление или слияние.
 *
 * Шаблоны — подстрока с `*` по краям: так их задевают и `command git`, и
 * `/usr/bin/git`, и `git.exe`, и `git -C ../x`, и `bash -c "git …"` (CLI сверяет
 * правило со звеном целиком). Лишнее задетое (`git log --merges`) брокер решает
 * обычными правилами чата — в авторежиме оно проходит само, а не стоит
 * карточкой. Перечень — те же подкоманды, что `destroysOrMerges`.
 */
export const CHAT_GIT_ASK: readonly string[] = [
  'Bash(*git*merge*)',
  // `-*d*`, а не `-d`: склеенные ключи (`-fd`, `-qD`, `-rd`) и сокращения
  // (`--del`) раньше шли мимо брокера (ревью 23.10, A-21, A-22). Лишнее задетое
  // (`git push origin feat/add`) брокер пропускает обычными правилами.
  'Bash(*git*branch*-*d*)',
  'Bash(*git*branch*-*D*)',
  'Bash(*git*branch*-*M*)',
  'Bash(*git*branch*-*C*)',
  'Bash(*git*branch*-*f*)',
  'Bash(*git*branch*--mo*)',
  'Bash(*git*branch*--co*)',
  'Bash(*git*tag*-*d*)',
  'Bash(*git*push*-*d*)',
  // Не `*:*`: хвост `:*` CLI читает прежним синтаксисом «префикс» (`npm run
  // test:*`), и правило не задевало `git push origin :ветка` (живой прогон
  // `check-chat-git-ask.mjs`, 23.10). `**` в конце — та же «любая строка».
  'Bash(*git*push*:**)',
  'Bash(*git*push*--pru*)',
  'Bash(*git*push*--m*)',
  'Bash(*git*stash*drop*)',
  'Bash(*git*stash*clear*)',
  'Bash(*git*clean*)',
  'Bash(*git*worktree*remove*)',
  'Bash(*git*worktree*prune*)',
  'Bash(*git*update-ref*)',
  'Bash(*git*symbolic-ref*-*d*)',
  'Bash(*git*replace*-*d*)',
  // `-c alias.x='branch -D' x`, `xargs git` (подкоманда из ввода) — разбор
  // судит развёртку и неизвестную подкоманду (A-23).
  'Bash(*git*alias.*)',
  'Bash(*xargs*git*)',
  'Bash(*git*reflog*expire*)',
  'Bash(*git*reflog*delete*)',
  'Bash(*git*prune*)',
  'Bash(*git*filter-*)',
  'Bash(*git*notes*remove*)',
  'Bash(*git*remote*rm*)',
  'Bash(*git*remote*remove*)',
  'Bash(*git*submodule*deinit*)',
];

type FlagSettings = Record<string, unknown> & { permissions?: unknown };

/**
 * Настройки запуска с `CHAT_GIT_ASK` в `permissions.ask` — для авторежима с
 * брокером прав. Свои правила (`ask` группы, `deny`, `allow`) не заменяются:
 * список дополняется без повторов. Не авторежим или брокера нет — как было:
 * в `default`/`acceptEdits` брокер и так спрашивают о каждом неразрешённом.
 */
export function withChatGitAsk(
  settings: FlagSettings | undefined,
  run: { permissionMode?: string; broker: boolean },
): FlagSettings | undefined {
  if (run.permissionMode !== 'auto' || !run.broker) return settings;
  const permissions =
    settings?.permissions && typeof settings.permissions === 'object'
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const own = Array.isArray(permissions.ask) ? (permissions.ask as unknown[]) : [];
  // И для инструмента PowerShell (I-08): `Bash(…)` его не задевает.
  const ask = [...new Set([...own, ...withPowerShellTwins(CHAT_GIT_ASK)])];
  return { ...settings, permissions: { ...permissions, ask } };
}
