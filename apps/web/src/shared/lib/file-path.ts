/**
 * Путь разрезан на каталог и имя: в узком списке сжимается только каталог, имя
 * файла видно всегда. Обрезать путь с конца — значит прятать ровно то, что ищут
 * глазами. Разделитель только `/`: git отдаёт пути так на любой ОС, и дерево
 * файлов проекта — тоже.
 *
 * Живёт в `shared`: одинаково нужен пульту git и списку изменённых в окне кода,
 * а фичи друг к другу не ходят.
 */
export function splitPath(value: string): { dir: string; name: string } {
  const cut = value.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: value }
    : { dir: value.slice(0, cut + 1), name: value.slice(cut + 1) };
}

/**
 * Один ли это каталог: разделители и хвостовой слэш не в счёт, а регистр — только
 * у путей Windows (с буквой диска): там он не различается, а на Linux/macOS
 * `App` и `app` — два разных каталога.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}
