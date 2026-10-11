// Чистая часть хука панели: разбор хвоста транскрипта и ответы CLI. Отдельно от
// самого хука, чтобы её проверяли тесты, — хук запускается голым node, без
// сборки, поэтому .mjs.

/**
 * Записи хвоста транскрипта: вызовы инструментов и их результаты. Первая
 * строка хвоста обычно обрезана посередине — её и любую битую строку
 * пропускаем.
 */
export function scanTranscript(text) {
  const uses = [];
  const results = new Set();
  for (const line of text.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        uses.push({ id: block.id, name: block.name, input: block.input });
      }
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.add(block.tool_use_id);
      }
    }
  }
  return { uses, results };
}

/**
 * Какой вызов ждёт решения. Во входе `PermissionRequest` нет id вызова (замер
 * 11.10.2026, claude 2.1.286), а запись о вызове уже лежит в транскрипте к
 * старту хука. Среди вызовов того же инструмента без результата берём тот, чей
 * ввод совпал; не совпал ни один — последний.
 */
export function findToolUseId(text, toolName, input) {
  const { uses, results } = scanTranscript(text);
  const open = uses.filter((use) => use.name === toolName && !results.has(use.id));
  const wanted = JSON.stringify(input ?? {});
  const exact = open.filter((use) => JSON.stringify(use.input ?? {}) === wanted);
  return (exact.at(-1) ?? open.at(-1))?.id;
}

/** Ответили ли на вызов в окне: его результат уже в транскрипте. */
export function hasToolResult(text, toolUseId) {
  return scanTranscript(text).results.has(toolUseId);
}

/** Решение с телефона в форме, которую CLI ждёт от хука `PermissionRequest`. */
export function permissionOutput(result, toolInput) {
  if (result?.state === 'answered') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...toolInput, answers: result.answers } },
      },
    };
  }
  if (result?.state === 'decided') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          result.behavior === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'Пользователь запретил это действие с телефона.' },
      },
    };
  }
  return undefined;
}

/** Текст для агента: что человек написал с телефона, пока тот работал. */
function phoneMessagesText(texts) {
  const body = texts.map((text) => text.trim()).join('\n\n---\n\n');
  return (
    'Пользователь написал с телефона, пока ты работал. Прочитай и учти это сейчас, ' +
    `не дожидаясь конца задачи:\n\n${body}`
  );
}

/**
 * Сообщения в ход: после шага — контекстом к результату (`PostToolUse`), в
 * конце хода — отказом остановиться с причиной (`Stop`), и ход продолжается.
 */
export function messagesOutput(event, texts) {
  if (texts.length === 0) return undefined;
  const text = phoneMessagesText(texts);
  if (event === 'PostToolUse') {
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
  }
  if (event === 'Stop') return { decision: 'block', reason: text };
  return undefined;
}
