/**
 * Построчное чтение YAML конфигов CI — без YAML-библиотеки (ноль зависимостей в ядре сверх
 * объявленных): ключ строки, цепочка родителей, соседний ключ того же шага, значение-блок.
 */

export interface KeyLine {
  key: string;
  /** Отступ самого ключа (у `- key:` — после `- `). */
  keyIndent: number;
  /** Строка начинает элемент списка (`- key: …`). */
  dash: boolean;
  rest: string;
}

const KEY_RE = /^(\s*)(-\s+)?([A-Za-z0-9_.-]+|"[^"]*"|'[^']*')\s*:(?:\s+(.*))?$/;

export function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

export function unquote(v: string): string {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

export function keyLine(line: string): KeyLine | null {
  const m = KEY_RE.exec(line);
  if (!m) return null;
  return {
    key: unquote(m[3] as string),
    keyIndent: (m[1] as string).length + (m[2] ? (m[2] as string).length : 0),
    dash: m[2] !== undefined,
    rest: m[4] ?? '',
  };
}

/** Значение скаляра без хвостового комментария (` # …` вне кавычек). */
export function scalar(rest: string): string {
  const t = rest.trim();
  if (/^['"]/.test(t)) return unquote(t);
  return t.replace(/\s+#.*$/, '').trim();
}

export interface Ancestor {
  index: number;
  key: string;
}

/** Родители строки `at` снизу вверх: ближайший ключ с меньшим отступом, затем его родитель… */
export function ancestors(lines: readonly string[], at: number): Ancestor[] {
  const out: Ancestor[] = [];
  let target = keyLine(lines[at] as string)?.keyIndent ?? indentOf(lines[at] as string);
  for (let j = at - 1; j >= 0 && target > 0; j -= 1) {
    const k = keyLine(lines[j] as string);
    if (!k || k.keyIndent >= target) continue;
    out.push({ index: j, key: k.key });
    target = k.keyIndent;
  }
  return out;
}

/** Соседний ключ того же отображения (того же шага): `working-directory:` рядом с `run:`. */
export function siblingValue(
  lines: readonly string[],
  at: number,
  key: string,
): string | undefined {
  const self = keyLine(lines[at] as string);
  if (!self) return undefined;
  const K = self.keyIndent;
  const same = (j: number): 'hit' | 'stop' | 'skip' => {
    const line = lines[j] as string;
    if (line.trim() === '' || line.trim().startsWith('#')) return 'skip';
    const k = keyLine(line);
    if (!k) return indentOf(line) < K ? 'stop' : 'skip';
    if (k.keyIndent > K) return 'skip';
    if (k.keyIndent < K) return 'stop';
    return k.key === key ? 'hit' : 'skip';
  };
  if (!self.dash)
    for (let j = at - 1; j >= 0; j -= 1) {
      const s = same(j);
      if (s === 'hit') return scalar(keyLine(lines[j] as string)?.rest ?? '');
      if (s === 'stop') break;
      // Начало элемента списка — начало шага: выше уже другой шаг.
      if (keyLine(lines[j] as string)?.dash && keyLine(lines[j] as string)?.keyIndent === K) break;
    }
  for (let j = at + 1; j < lines.length; j += 1) {
    const k = keyLine(lines[j] as string);
    if (k?.dash && k.keyIndent === K) break;
    const s = same(j);
    if (s === 'hit') return scalar(k?.rest ?? '');
    if (s === 'stop') break;
  }
  return undefined;
}

/** Значение ключа: в строке или блоком `|` / `>` ниже; список `- …` (элементы и блоки `- |`). */
export function blockValues(
  lines: readonly string[],
  at: number,
  keyIndent: number,
  inline: string,
): string[] {
  const value = inline.trim();
  if (value !== '' && !/^[|>][-+]?$/.test(value)) {
    if (value.startsWith('[') && value.endsWith(']'))
      return value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    return [unquote(value)];
  }
  if (value !== '') return blockBelow(lines, at, keyIndent, value.startsWith('>'));
  const out: string[] = [];
  let itemIndent = -1;
  // Список `- …`: YAML разрешает элементы и на отступе самого ключа (частый вид у GitLab).
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (ind < keyIndent || (ind === keyIndent && !item)) break;
    if (item && itemIndent < 0) itemIndent = ind;
    if (!item || ind !== itemIndent) continue;
    const head = (item[1] as string).trim();
    // Элемент-блок (`- |`): его строки — глубже дефиса.
    if (/^[|>][-+]?$/.test(head)) out.push(...blockBelow(lines, i, ind, head.startsWith('>')));
    else out.push(unquote(head));
  }
  return out;
}

function blockBelow(
  lines: readonly string[],
  at: number,
  indent: number,
  folded: boolean,
): string[] {
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    if (indentOf(line) <= indent) break;
    out.push(line.trim());
  }
  return folded ? [out.join(' ')] : out;
}
