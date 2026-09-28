/**
 * Файлы из буфера обмена и из перетаскивания. Один разбор на все поля агента:
 * раньше чат принимал перетаскивание, но не вставку, а остальные поля — ничего,
 * и снимок экрана, вставленный Ctrl+V, молча превращался в пустоту.
 */

/** Часть `DataTransfer`, которую читаем: так разбор проверяется без браузера. */
export interface TransferLike {
  readonly types?: readonly string[];
  readonly files?: ArrayLike<File> | null;
  readonly items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
}

/**
 * Несут ли данные файлы. Во время `dragover` сами файлы браузер не отдаёт —
 * только их наличие в `types`; по нему и решаем, подсвечивать ли поле.
 */
export function carriesFiles(data: TransferLike | null | undefined): boolean {
  return Boolean(data?.types && Array.from(data.types).includes('Files'));
}

/**
 * Файлы из вставки или перетаскивания. `items` — основной источник: у вставки
 * снимка экрана `files` в части браузеров пуст, а файл лежит элементом вида
 * `file`. Нет `items` — берём `files`.
 */
export function filesOf(data: TransferLike | null | undefined): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []);
}

/**
 * Имя для вставленного файла. Снимок из буфера приходит с именем `image.png`
 * у каждого — два снимка подряд стали бы неразличимы в чипах и в строке
 * «Attached images», поэтому безымянному вставленному даём имя со временем.
 */
export function pastedName(file: { name: string; type: string }, now: Date): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file.name;
  const ext = extensionForType(file.type) ?? (file.name.split('.').pop() || 'png');
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pasted-${stamp}.${ext.toLowerCase()}`;
}

function extensionForType(type: string): string | undefined {
  if (type === 'image/png') return 'png';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/webp') return 'webp';
  return undefined;
}

/**
 * Имя, не совпадающее с уже приложенными: `shot.png` второй раз — `shot-2.png`.
 * Модель видит картинки по порядку и строку имён; два одинаковых имени в ней не
 * различить, а человеку не понять, какой чип убирает.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
