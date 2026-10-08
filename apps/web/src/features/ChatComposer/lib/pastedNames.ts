import { uniqueName, pastedName } from '@shared/lib/attach';

/**
 * Имена вставленных из буфера файлов. Имя вставки — с точностью до секунды, и
 * два снимка одной секунды давали чипы-двойники: какой из них убрать крестиком,
 * было не понять. Занятые — имена уже приложенных файлов.
 */
export function pastedNames(
  pasted: readonly { name: string; type: string }[],
  attached: readonly string[],
  now: Date,
): string[] {
  const taken = new Set(attached);
  return pasted.map((file) => {
    const name = uniqueName(pastedName(file, now), taken);
    taken.add(name);
    return name;
  });
}
