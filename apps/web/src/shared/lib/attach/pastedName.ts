export function extensionForType(type: string): string | undefined {
  if (type === 'image/png') return 'png';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/webp') return 'webp';
  return undefined;
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
