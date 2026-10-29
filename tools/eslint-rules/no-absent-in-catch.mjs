// Правило линта ядра (01 §Facts, P44): «нет» нельзя получить из `catch`.
// Сбой чтения (EPERM, таймаут, мусор) — это `unknown(причина)`; вернуть из обработчика
// исключения `absent` значит снова прочитать сбой диска как «файла нет» (F25).
// Ловится любое появление «нет» внутри тела `catch` (кроме вложенных функций, у которых
// своя судьба): вызов `absent()`, имя `ABSENT`, литерал `{ absent: true }`.

/** @param {import('estree').Node} node */
function isAbsentLiteral(node) {
  if (node.type !== 'ObjectExpression') return false;
  return node.properties.some(
    (p) =>
      p.type === 'Property' &&
      !p.computed &&
      ((p.key.type === 'Identifier' && p.key.name === 'absent') ||
        (p.key.type === 'Literal' && p.key.value === 'absent')) &&
      p.value.type === 'Literal' &&
      p.value.value === true,
  );
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Имя вызываемого метода: `x.catch(…)`, `x?.catch(…)`, `x['catch'](…)`. */
function methodName(call) {
  const callee = call.callee.type === 'ChainExpression' ? call.callee.expression : call.callee;
  if (callee.type !== 'MemberExpression') return undefined;
  if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  if (callee.computed && callee.property.type === 'Literal') return String(callee.property.value);
  return undefined;
}

/**
 * Функция — обработчик отказа промиса (асинхронный двойник `catch`, F-81): единственный
 * аргумент `.catch(fn)` или второй аргумент `.then(ok, fn)`.
 */
function isRejectionHandler(fn, parent) {
  if (!parent || parent.type !== 'CallExpression') return false;
  const at = parent.arguments.indexOf(fn);
  const name = methodName(parent);
  return (name === 'catch' && at === 0) || (name === 'then' && at === 1);
}

/**
 * Ближайший предок — `catch`, блок `finally` или обработчик отказа промиса раньше любой другой
 * функции? `finally` идёт и после сбоя: «нет» оттуда перекрывает исключение.
 */
function insideCatch(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const node = ancestors[i];
    if (FUNCTION_TYPES.has(node.type)) return isRejectionHandler(node, ancestors[i - 1]);
    if (node.type === 'CatchClause') return true;
    const parent = ancestors[i - 1];
    if (parent?.type === 'TryStatement' && parent.finalizer === node) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noAbsentInCatch = {
  meta: {
    type: 'problem',
    docs: { description: 'absent() must not be produced inside a catch block (P44)' },
    messages: {
      absentInCatch:
        'Из catch нельзя вернуть «нет»: ошибка чтения — это unknown(причина), а не absent (01 §Facts, P44).',
    },
    schema: [],
  },
  create(context) {
    const report = (node) => {
      const ancestors = context.sourceCode.getAncestors(node);
      if (insideCatch(ancestors)) context.report({ node, messageId: 'absentInCatch' });
    };
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'absent') report(node);
      },
      Identifier(node) {
        if (node.name !== 'ABSENT') return;
        const parent = context.sourceCode.getAncestors(node).at(-1);
        // Объявление и импорт самой константы — не её выдача.
        if (parent?.type === 'ImportSpecifier' || parent?.type === 'VariableDeclarator') return;
        report(node);
      },
      ObjectExpression(node) {
        if (isAbsentLiteral(node)) report(node);
      },
    };
  },
};

export const agentdeckCorePlugin = {
  meta: { name: 'agentdeck-core' },
  rules: { 'no-absent-in-catch': noAbsentInCatch },
};
