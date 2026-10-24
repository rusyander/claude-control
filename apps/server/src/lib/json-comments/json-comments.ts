/**
 * JSON с комментариями — так, как его читают CLI на `strip-json-comments`
 * (Qwen Code: каждый файл настроек, `chunk-EVNJAS37.js` 0.24.3): `//` до конца
 * строки и `/* … *\/` вне строк заменяются пробелами, переводы строк остаются
 * (номера строк в ошибке разбора те же), висячие запятые НЕ снимаются — их CLI
 * тоже не прощает. Незакрытый блочный комментарий тянется до конца текста.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    if (inString) {
      if (char === '\\') {
        out += char + (next ?? '');
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : next === '/' ? close : close + 2;
      out += blank(text.slice(index, end));
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Комментарий → пробелы той же длины, переводы строк на месте. */
function blank(comment: string): string {
  return comment.replace(/[^\r\n]/g, ' ');
}
