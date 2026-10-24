import type { Word } from './shell-parse.ts';

/**
 * Куда звено распакует архив (RF-BGCD-04, решение координатора 24.10): в архиве
 * могут лежать ссылки наружу, а до запуска на диске их нет — `tar -xzf x.tgz -C
 * "$d" && rm -rf "$d/pkg/"*` снёс бы цель ссылки как уборку временного. Сама
 * распаковка — обычная работа; человеку уходит только шаг ЭТОЙ же команды,
 * идущий сквозь распакованное (`LinkLedger.crosses`). Распакованное раньше
 * сверяет живая проверка настоящего пути (`escapesBase`).
 *
 * Возвращает каталоги распаковки (`.` — каталог звена; `undefined` — не узнать);
 * пустой список — звено не распаковывает. `name` — имя без пути, `.exe` и регистра.
 */
export function unpackPaths(name: string, words: Word[]): (Word | undefined)[] {
  const args = words.slice(1);
  switch (name) {
    case 'tar':
    case 'bsdtar':
    case 'gtar':
      return tarExtracts(args) ? tarDirectories(args) : [];
    case 'unzip':
      return args.some((arg) => /^-[a-zA-Z]*[ltvZpcz]/.test(arg.text) && !/^-d/.test(arg.text))
        ? []
        : [valueOf(args, /^-d$/, /^-d(.+)$/) ?? HERE];
    case '7z':
    case '7za':
    case '7zz':
    case '7zr':
      return /^[xe]$/i.test(args[0]?.text ?? '') ? [valueOf(args, /(?!)/, /^-o(.+)$/) ?? HERE] : [];
    case 'expand-archive':
      return [expandArchiveDestination(args)];
    // Прочие распаковщики — каталог не разбираем: всё ниже чего угодно — не узнать.
    case 'jar':
      return /^-?[a-z]*x/.test(args[0]?.text ?? '') ? [undefined] : [];
    case 'cpio':
    case 'bsdcpio':
      return args.some((arg) => /^(-[a-zA-Z]*i|--extract)/.test(arg.text)) ? [undefined] : [];
    case 'pax':
      return args.some((arg) => /^-[a-zA-Z]*r/.test(arg.text)) ? [undefined] : [];
    case 'unrar':
    case 'unar':
    case 'ar':
      return name === 'unar' || /^-?[a-z]*[xe]/i.test(args[0]?.text ?? '') ? [undefined] : [];
    // Строку `cmd /c "…"` обход разбирает на звенья: её `tar` придёт сюда сам.
    default:
      return [];
  }
}

const HERE: Word = { text: '.', dynamic: false };

/** Режим `tar` — извлечение: `xf`, `-xzf`, `--extract`, `--get`. */
function tarExtracts(args: Word[]): boolean {
  const first = args[0]?.text ?? '';
  if (/^[a-zA-Z]+$/.test(first) && first.includes('x')) return true;
  return args.some((arg) => /^-[a-zA-Z]*x/.test(arg.text) || /^--(extract|get)$/.test(arg.text));
}

/** Каталоги `-C` / `--directory`; без них — каталог звена. */
function tarDirectories(args: Word[]): (Word | undefined)[] {
  const found: (Word | undefined)[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if (text === '-C' || text === '--directory') found.push(args[i + 1]);
    else if (text.startsWith('--directory=')) {
      found.push({ ...(args[i] as Word), text: text.slice('--directory='.length) });
    }
  }
  return found.length > 0 ? found : [HERE];
}

/** Значение ключа отдельным словом (`whole`) или слитно (`joined`, первая группа). */
function valueOf(args: Word[], whole: RegExp, joined: RegExp): Word | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (whole.test(arg.text)) return args[i + 1] ?? { text: '', dynamic: true };
    const match = joined.exec(arg.text);
    if (match) return { ...arg, text: match[1] as string };
  }
  return undefined;
}

/** `Expand-Archive [-Path] a.zip [-DestinationPath] D`; параметр — любым началом имени. */
function expandArchiveDestination(args: Word[]): Word | undefined {
  const positional: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const lower = arg.text.toLowerCase();
    if (!lower.startsWith('-') || arg.dynamic) positional.push(arg);
    else if (lower.length > 1 && '-destinationpath'.startsWith(lower)) return args[i + 1];
    else if (/^-(p|pa|pat|path|l\w*)$/.test(lower)) i += 1;
  }
  return positional[1] ?? HERE;
}
