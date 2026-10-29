/**
 * Разбор блочного YAML для схем контрактов (04:130, OpenAPI в YAML) без зависимости: карты,
 * списки, скаляры в кавычках и без, `|` / `>`, плоские `[a, b]` / `{a: b}`. Якоря, ссылки и
 * теги не поддержаны — исключение с причиной, и проверка контракта получает `no-verdict(engine)`,
 * а не ложную разницу.
 */

type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) return text.slice(0, i);
  }
  return text;
}

function scalar(raw: string, no: number): Yaml {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (/^[&*!]/.test(v)) throw new Error(`yaml line ${no}: anchors, aliases and tags not supported`);
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('[') || v.startsWith('{')) return flow(v, no);
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function keyAt(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function keyText(raw: string, no: number): string {
  const k = scalar(raw, no);
  return k === null ? 'null' : String(k);
}

function flow(v: string, no: number): Yaml {
  const body = v.slice(1, -1).trim();
  if (v.startsWith('[')) return body === '' ? [] : splitTop(body).map((p) => scalar(p, no));
  const out: Record<string, Yaml> = {};
  if (body === '') return out;
  for (const part of splitTop(body)) {
    const at = keyAt(part);
    if (at < 0) throw new Error(`yaml line ${no}: flow map entry without key`);
    out[keyText(part.slice(0, at), no)] = scalar(part.slice(at + 1), no);
  }
  return out;
}

export function parseYaml(text: string): Yaml {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines: Line[] = [];
  raw.forEach((r, i) => {
    if (/\t/.test(/^\s*/.exec(r)?.[0] ?? '')) throw new Error(`yaml line ${i + 1}: tab indent`);
    if (/^(---|\.\.\.)\s*$/.test(r)) return;
    const body = stripComment(r);
    if (body.trim() === '') return;
    lines.push({ indent: body.length - body.trimStart().length, text: body.trim(), no: i + 1 });
  });
  let pos = 0;

  function blockScalar(header: string, parentIndent: number, startNo: number): string {
    const folded = header.startsWith('>');
    const out: string[] = [];
    // Блочный скаляр берёт сырые строки (комментарии внутри — текст), до строки с отступом не глубже родителя.
    let i = startNo; // индекс сырой строки после заголовка
    let indent = -1;
    while (i < raw.length) {
      const r = raw[i] as string;
      if (r.trim() === '') {
        out.push('');
        i += 1;
        continue;
      }
      const ind = r.length - r.trimStart().length;
      if (ind <= parentIndent) break;
      if (indent < 0) indent = ind;
      out.push(r.slice(indent));
      i += 1;
    }
    while (pos < lines.length && (lines[pos] as Line).no <= i) pos += 1;
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    const joined = folded ? out.join(' ').replace(/ {2,}/g, ' ') : out.join('\n');
    return header.includes('-') ? joined : `${joined}\n`;
  }

  function value(rest: string, line: Line): Yaml {
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, line.indent, line.no);
    if (rest !== '') return scalar(rest, line.no);
    const next = lines[pos];
    if (!next) return null;
    if (next.indent > line.indent) return block(next.indent);
    if (next.indent === line.indent && /^-(\s|$)/.test(next.text)) return block(next.indent);
    return null;
  }

  function block(indent: number): Yaml {
    const first = lines[pos];
    if (!first) return null;
    if (/^-(\s|$)/.test(first.text)) {
      const list: Yaml[] = [];
      while (pos < lines.length) {
        const line = lines[pos] as Line;
        if (line.indent !== indent || !/^-(\s|$)/.test(line.text)) break;
        const rest = line.text.slice(1).trim();
        if (rest !== '' && keyAt(rest) >= 0 && !/^["'[{]/.test(rest)) {
          // `- key: v` — карта, первая строка которой сидит после дефиса.
          const shift = line.text.length - rest.length;
          lines[pos] = { indent: indent + shift, text: rest, no: line.no };
          list.push(block(indent + shift));
          continue;
        }
        pos += 1;
        list.push(value(rest, line));
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (pos < lines.length) {
      const line = lines[pos] as Line;
      if (line.indent !== indent || /^-(\s|$)/.test(line.text)) break;
      const at = keyAt(line.text);
      if (at < 0) throw new Error(`yaml line ${line.no}: expected "key: value"`);
      pos += 1;
      map[keyText(line.text.slice(0, at), line.no)] = value(line.text.slice(at + 1).trim(), line);
    }
    return map;
  }

  if (lines.length === 0) return null;
  const doc = block((lines[0] as Line).indent);
  if (pos < lines.length) {
    throw new Error(`yaml line ${(lines[pos] as Line).no}: unexpected indent`);
  }
  return doc;
}
