/**
 * Путь файла внутри глобального слоя, через `/`: подпись строки уже говорит
 * «у вас в ~/.claude», и полный путь повторял бы домашнюю папку (с именем
 * пользователя) в каждой строке. Чужой путь возвращается как есть.
 */
export function insideGlobal(path: string, globalDir: string): string {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = norm(path);
  const root = norm(globalDir);
  const caseless = /^[a-z]:\//i.test(root);
  const prefix = `${root}/`;
  const starts = caseless
    ? file.toLowerCase().startsWith(prefix.toLowerCase())
    : file.startsWith(prefix);
  return root && starts ? file.slice(prefix.length) : path;
}
