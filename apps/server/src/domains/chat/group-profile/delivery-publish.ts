/**
 * Публикация до звена доставки — второй рубеж за `DELIVERY_BASH_DENY` (RF-BGCD-07).
 *
 * Правило `deny` CLI — шаблон по тексту команды: `bash -c 'git push'`, `Git push`,
 * `GIT.EXE push`, `eval git push`, `git send-pack` под него не попадали, и одни шли
 * к классификатору авторежима, другие — к брокеру прав, а брокер пуш своей ветки
 * разрешает сам: стадия до доставки публиковала ветку. Здесь — разбор слов, а не
 * шаблон: имя git в любом регистре и любым путём, кавычки и вложенная оболочка
 * сняты, глобальные ключи перед подкомандой пропущены.
 *
 * Не видно отсюда: имя git в переменной (`g=git; $g push`) — настоящий CLI такую
 * строку отказал сам (замер `cli-forms.mjs`), и пуш, разнесённый по двум вызовам.
 */

/** Глобальные ключи git со значением отдельным словом. */
const GIT_VALUE_FLAGS = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

/** Подкоманды git, которые отправляют ветку на сервер. */
const PUBLISH_VERBS = new Set(['push', 'send-pack']);

/** Слова команды: кавычки сняты, разделители оболочки (`;`, `&&`, `|`, `$(`, `` ` ``) — пробел. */
function words(command: string): string[] {
  return command
    .replace(/["'`]/g, '')
    .split(/[\s;&|()<>{}$]+/)
    .filter(Boolean);
}

/** Имя программы без пути и без `.exe`, в нижнем регистре: `C:\…\GIT.EXE` → `git`. */
function program(word: string): string {
  return (
    word
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.exe$/i, '')
      .toLowerCase() ?? ''
  );
}

/**
 * Подкоманды git в команде (в нижнем регистре), по каждому вызову git — с
 * пропуском глобальных ключей; псевдоним из `-c alias.x=push` — его подкомандой.
 */
export function gitVerbs(command: string): string[] {
  const list = words(command);
  const verbs: string[] = [];
  for (let at = 0; at < list.length; at += 1) {
    if (program(list[at] ?? '') !== 'git') continue;
    let next = at + 1;
    while (next < list.length && (list[next] ?? '').startsWith('-')) {
      const flag = list[next] ?? '';
      const value = GIT_VALUE_FLAGS.has(flag) ? list[next + 1] : undefined;
      const alias = /^alias\.[^=]+=(.*)$/i.exec(value ?? flag.replace(/^-c/, ''));
      if (alias) verbs.push(...(alias[1] ?? '').toLowerCase().split(/\s+/).filter(Boolean));
      next += value === undefined ? 1 : 2;
    }
    const verb = list[next];
    if (verb) verbs.push(verb.toLowerCase());
  }
  return verbs;
}

/** Команда отправляет ветку на сервер (`push`, `send-pack`) в любой записи git. */
export function pushesBranch(command: string): boolean {
  return gitVerbs(command).some((verb) => PUBLISH_VERBS.has(verb));
}

/** Команда отправляет пакет в обход `git push` (`send-pack`) — разбора цели у брокера нет. */
export function sendsPack(command: string): boolean {
  return gitVerbs(command).includes('send-pack');
}

/** CLI форжа открывает MR / PR: `gh pr create`, `glab mr create` (любым путём и регистром). */
function opensRequest(command: string): boolean {
  const list = words(command);
  return list.some((word, at) => {
    const name = program(word);
    const kind = list[at + 1]?.toLowerCase();
    return (
      ((name === 'gh' && kind === 'pr') || (name === 'glab' && kind === 'mr')) &&
      list[at + 2]?.toLowerCase() === 'create'
    );
  });
}

/** Звено до доставки публикует: пуш ветки или открытие MR — дело звена доставки. */
export function publishesBeforeDelivery(command: string): boolean {
  return pushesBranch(command) || opensRequest(command);
}

/**
 * Текст вызова оболочки для проверок публикации — Bash как есть, PowerShell с
 * запятыми списка аргументов как разделителями (`Start-Process git -ArgumentList
 * 'push','origin'`), прочие инструменты — `undefined` (R2/R3: инструмент
 * PowerShell проходил мимо `sendsPack` и `publishesBeforeDelivery`).
 */
export function publishTextOf(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return undefined;
  const command = String((input as { command?: unknown } | null)?.command ?? '');
  return toolName === 'PowerShell' ? command.replace(/,/g, ' ') : command;
}

/** Отказ звену до доставки — модели, по-английски, как и вся системная дописка. */
export const PUBLISH_BEFORE_DELIVERY_DENIED =
  'Publishing is refused in this stage: a later delivery stage of this chain pushes the branch ' +
  'and opens the MR. Commit your work and finish the stage — do not push, send-pack or open the ' +
  'MR by any other form (a shell wrapper, another spelling of git, eval).';

/** Отказ группе на `git send-pack`: цель такого пуша брокер не разбирает. */
export const SEND_PACK_DENIED =
  'git send-pack is refused in a split group: its target is not checked. Use `git push` to your ' +
  'own branch instead.';
