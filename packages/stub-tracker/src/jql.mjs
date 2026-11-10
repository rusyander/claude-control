/**
 * Подмножество JQL заглушки: условия через AND (без OR и скобок условий) и хвост ORDER BY.
 *
 *   project | key | labels | assignee | reporter | status | statusCategory | type | issuetype |
 *   priority | parent   =  !=  in (…)  not in (…)  is EMPTY  is not EMPTY
 *   text | summary | description   ~   "…"
 *   значения: "строка в кавычках" с \" и \\, слово, currentUser()
 *
 * Чего подмножество не знает — 400 с `errorMessages`, как у Jira: незнакомое условие тихо не
 * отбрасывается (иначе тест видел бы «нашлось всё»).
 */

export class JqlError extends Error {}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '"' || ch === "'") {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\' && i + 1 < source.length) i += 1;
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new JqlError('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
    } else if ('(),'.includes(ch)) {
      tokens.push({ kind: ch });
      i += 1;
    } else if (ch === '!' && source[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' });
      i += 2;
    } else if (ch === '=' || ch === '~') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
    } else {
      const match = /^[^\s(),=!~"']+/.exec(source.slice(i));
      if (!match) throw new JqlError(`unexpected «${ch}»`);
      tokens.push({ kind: 'word', value: match[0] });
      i += match[0].length;
    }
  }
  return tokens;
}

const FIELDS = new Set([
  'project',
  'key',
  'labels',
  'assignee',
  'reporter',
  'status',
  'statuscategory',
  'type',
  'issuetype',
  'priority',
  'parent',
  'text',
  'summary',
  'description',
]);
const TEXT_FIELDS = new Set(['text', 'summary', 'description']);
const ORDER_FIELDS = new Set(['key', 'created', 'updated', 'priority']);

/** JQL → { clauses, order }; ошибка разбора — `JqlError`. */
export function parseJql(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const word = (value) =>
    peek()?.kind === 'word' && peek().value.toLowerCase() === value ? (pos++, true) : false;

  function value() {
    const token = tokens[pos++];
    if (!token) throw new JqlError('value expected');
    if (token.kind === 'string') return token.value;
    if (token.kind !== 'word') throw new JqlError('value expected');
    if (token.value.toLowerCase() === 'currentuser' && peek()?.kind === '(') {
      pos += 1;
      if (tokens[pos++]?.kind !== ')') throw new JqlError('currentUser() expected');
      return { currentUser: true };
    }
    return token.value;
  }

  function list() {
    if (tokens[pos++]?.kind !== '(') throw new JqlError('( expected');
    const out = [value()];
    while (peek()?.kind === ',') {
      pos += 1;
      out.push(value());
    }
    if (tokens[pos++]?.kind !== ')') throw new JqlError(') expected');
    return out;
  }

  function clause() {
    const fieldToken = tokens[pos++];
    if (fieldToken?.kind !== 'word') throw new JqlError('field expected');
    const field = fieldToken.value.toLowerCase();
    if (!FIELDS.has(field)) throw new JqlError(`Field '${fieldToken.value}' is not supported`);
    if (word('is')) {
      const negate = word('not');
      if (!word('empty') && !word('null')) throw new JqlError('EMPTY expected');
      return { field, op: negate ? 'not-empty' : 'empty' };
    }
    if (word('not')) {
      if (!word('in')) throw new JqlError('IN expected');
      return { field, op: 'not-in', values: list() };
    }
    if (word('in')) return { field, op: 'in', values: list() };
    const op = tokens[pos++];
    if (op?.kind !== 'op') throw new JqlError('operator expected');
    if (op.value === '~' && !TEXT_FIELDS.has(field))
      throw new JqlError(`operator ~ is not supported for ${field}`);
    if (op.value !== '~' && TEXT_FIELDS.has(field))
      throw new JqlError(`field ${field} supports only ~`);
    return { field, op: op.value, values: [value()] };
  }

  const clauses = [];
  const order = [];
  while (pos < tokens.length) {
    if (word('order')) {
      if (!word('by')) throw new JqlError('BY expected');
      for (;;) {
        const field = tokens[pos++];
        if (field?.kind !== 'word' || !ORDER_FIELDS.has(field.value.toLowerCase()))
          throw new JqlError('order field expected');
        const desc = word('desc');
        if (!desc) word('asc');
        order.push({ field: field.value.toLowerCase(), desc });
        if (peek()?.kind !== ',') break;
        pos += 1;
      }
      if (pos < tokens.length) throw new JqlError('unexpected tail after ORDER BY');
      break;
    }
    clauses.push(clause());
    if (pos < tokens.length && !word('and')) {
      if (peek()?.kind === 'word' && peek().value.toLowerCase() === 'order') continue;
      throw new JqlError('AND expected');
    }
  }
  return { clauses, order };
}

function fieldValues(issue, field) {
  if (field === 'project') return [issue.project];
  if (field === 'key') return [issue.key];
  if (field === 'labels') return issue.labels;
  if (field === 'assignee') return issue.assignee ? [issue.assignee] : [];
  if (field === 'reporter') return [];
  if (field === 'status') return [issue.status];
  if (field === 'statuscategory') return [issue.statusCategory];
  if (field === 'type' || field === 'issuetype') return [issue.type];
  if (field === 'priority') return [issue.priority];
  if (field === 'parent') return issue.parent ? [issue.parent] : [];
  if (field === 'summary') return [issue.summary];
  if (field === 'description') return [issue.description];
  return [issue.summary, issue.description, ...issue.comments.map((c) => c.text)];
}

function resolve(value, actor) {
  return typeof value === 'object' ? (actor?.name ?? '') : String(value);
}

function matches(issue, clause, actor) {
  const have = fieldValues(issue, clause.field);
  if (clause.op === 'empty') return have.length === 0;
  if (clause.op === 'not-empty') return have.length > 0;
  const wanted = clause.values.map((v) => resolve(v, actor).toLowerCase());
  const lower = have.map((h) => String(h).toLowerCase());
  if (clause.op === '~') return lower.some((h) => h.includes(wanted[0]));
  const hit = lower.some((h) => wanted.includes(h));
  return clause.op === '=' || clause.op === 'in' ? hit : !hit;
}

const keyNumber = (key) => Number(key.split('-').pop());

/** Задачи по разобранному JQL; порядок по умолчанию — свежие правки первыми. */
export function runJql(issues, parsed, actor) {
  const found = issues.filter((issue) => parsed.clauses.every((c) => matches(issue, c, actor)));
  const order = parsed.order.length > 0 ? parsed.order : [{ field: 'updated', desc: true }];
  return found.sort((a, b) => {
    for (const { field, desc } of order) {
      const av = field === 'key' ? keyNumber(a.key) : a[field];
      const bv = field === 'key' ? keyNumber(b.key) : b[field];
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (desc ? -1 : 1);
    }
    return keyNumber(b.key) - keyNumber(a.key);
  });
}
