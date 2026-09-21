import type { HookItem } from '@agentdeck/contracts/portable-env';
import { scriptPathOf } from '../normalize-hooks.ts';

/**
 * Команда хука в написании ЦЕЛИ.
 *
 * Скрипты хуков не копируются: они зовутся по своему пути на этой же машине
 * (перенос на ДРУГУЮ машину — это `env-transfer`, и там свои правила путей).
 * Значит, у чужого CLI путь обязан быть таким, чтобы он ДЕЙСТВИТЕЛЬНО
 * исполнился, а не просто выглядел записанным:
 *
 *  - АБСОЛЮТНЫМ. Относительный путь чужой CLI разрешает от СВОЕГО рабочего
 *    каталога, и хук, работавший у источника, у цели молча не находит скрипт.
 *    Абсолютный путь канон везёт сам (`HookItem.scriptPath` — уже разрешённый),
 *    а в тексте команды он может стоять в прежнем, относительном виде.
 *  - С РАЗДЕЛИТЕЛЕМ `/` даже на Windows. Обратная косая в строке команды —
 *    это экранирование для всякой оболочки семейства sh (`C:\hooks\x.mjs`
 *    превращается в `C:hooksx.mjs`), а прямую понимают одинаково и cmd, и bash,
 *    и сам Node. Написание целевой ОС здесь значит «то, что ОС исполнит», а не
 *    «то, как её проводник рисует путь».
 */
export function hookCommandForTarget(item: HookItem): string {
  if (!item.scriptPath) return item.command;

  const written = scriptPathOf(item.command);
  if (!written) return item.command;

  const spelled = item.scriptPath.split('\\').join('/');
  if (written === spelled) return item.command;

  const at = item.command.indexOf(written);
  if (at === -1) return item.command;

  // Кавычки НЕ добавляются, если путь уже стоит в кавычках: вторая пара сделала
  // бы аргументом пустую строку. Пробел в пути без кавычек — единственный
  // случай, когда их приходится ставить самим.
  const quoted = item.command[at - 1] === '"' || item.command[at - 1] === "'";
  const replacement = !quoted && spelled.includes(' ') ? `"${spelled}"` : spelled;
  return item.command.slice(0, at) + replacement + item.command.slice(at + written.length);
}
