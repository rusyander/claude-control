/**
 * Что делать с файлами, которые человек приложил к полю агента — кнопкой,
 * перетаскиванием или вставкой из буфера. Решение одно на все поля панели
 * (чат, агент панели, помощники форм и структуры, ассистент шага группы):
 * отказ — в момент вложения и с настоящим размером файла, а не молча и не при
 * отправке. Раньше слишком большой файл просто отсеивался — ни чипа, ни слова, —
 * и со стороны это выглядело сломанным перетаскиванием.
 */

/** Предел одного вложения — тот же, что у чата: «до 20 МБ». */
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

/** Отсеянные при вложении — их называют человеку, каждый со своей причиной. */
export interface AttachRejection {
  /** Тип, который поле не принимает: только имена. */
  unsupported: string[];
  /** Крупнее предела: имя и настоящий размер — «больше 20 МБ» без него не сверить. */
  tooLarge: { name: string; size: number }[];
}

export interface AttachPlan<T> extends AttachRejection {
  /** Файлы, которые лягут чипами. */
  accepted: T[];
}

export interface AttachRules {
  /** Принимает ли поле файл с таким именем. */
  accepts: (name: string) => boolean;
  /** Предел размера; ровно на границе — ещё можно. */
  maxBytes?: number;
}

export function planAttach<T extends { name: string; size: number }>(
  files: readonly T[],
  { accepts, maxBytes = ATTACH_MAX_BYTES }: AttachRules,
): AttachPlan<T> {
  const accepted: T[] = [];
  const unsupported: string[] = [];
  const tooLarge: { name: string; size: number }[] = [];

  for (const file of files) {
    // Тип раньше размера: .exe на 30 МБ не приложить ни в каком размере, и
    // совет «уменьшите файл» был бы ложным.
    if (!accepts(file.name)) unsupported.push(file.name);
    else if (file.size > maxBytes) tooLarge.push({ name: file.name, size: file.size });
    else accepted.push(file);
  }

  return { accepted, unsupported, tooLarge };
}

/** Есть ли что сказать человеку. */
export function hasRejections(rejection: AttachRejection): boolean {
  return rejection.unsupported.length > 0 || rejection.tooLarge.length > 0;
}
