/**
 * Грамматика текстового протокола инструментов — одна на всю прослойку.
 *
 * Платформа не принимает `tools` вовсе (`no-client-tools`, справочник §6), и
 * это не чинится настройкой: набор инструментов она собирает сама. Поэтому
 * инструменты клиента едут наверх ТЕКСТОМ, а вызов возвращается текстом же и
 * разбирается обратно в блоки диалекта. H1 (§2.3) показала, что настоящий
 * `claude` такой синтез принимает и файл создаётся.
 *
 * Здесь лежит только грамматика: ни сети, ни хранилища, ни диалектов. Текст
 * САМОГО протокола (правила для модели) сюда не попадает — он живёт промптом
 * каталога (`tool-protocol`, Т4) и приходит параметром: два описания одной
 * грамматики разошлись бы в первый же день, и человек правил бы промпт, не
 * меняя ничего.
 */

/**
 * Версия грамматики. Растёт, когда меняются ТЕГИ или поля вызова, — то есть
 * когда старый промпт перестаёт описывать то, что разбирает код.
 *
 * Проверяется тестом против промпта каталога: его первая строка называет ту же
 * версию. Разошлись — значит текст обещает модели одно, а разборщик ждёт
 * другого, и узнать об этом лучше на сборке, чем по молча не сработавшему
 * вызову.
 */
export const TOOL_PROTOCOL_VERSION = 1;

/** Теги вызова. Пишутся здесь по одному разу и больше нигде. */
export const CALL_OPEN = '<tool_call>';
export const CALL_CLOSE = '</tool_call>';
export const RESULT_CLOSE = '</tool_result>';

/** Открывающий тег результата: имя инструмента — атрибутом. */
export function resultOpen(name: string): string {
  return `<tool_result name="${name.replace(/"/g, '')}">`;
}

/** Инструмент в форме, не зависящей от диалекта клиента. */
export interface ShimTool {
  name: string;
  description: string;
  /** Схема аргументов как есть — она уедет к модели JSON-ом. */
  schema: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Список инструментов клиента → общая форма. Диалектов два, и различаются они
 * только упаковкой: у Anthropic поля лежат в корне, у OpenAI — под `function`.
 *
 * Инструмент без имени пропускается молча: имя — единственное, чем вызов
 * опознаётся, и безымянная строка в списке означала бы, что модель вправе
 * назвать пустоту.
 */
export function readTools(input: unknown): ShimTool[] {
  if (!Array.isArray(input)) return [];
  const tools: ShimTool[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const schema = fn.input_schema ?? fn.parameters ?? {};
    tools.push({
      name,
      description: typeof fn.description === 'string' ? fn.description.trim() : '',
      schema,
    });
  }
  return tools;
}

/** Версия протокола, названная самим текстом промпта. */
export function protocolVersionOf(text: string): number | undefined {
  const match = /верси[яи]\s+(\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Перечень инструментов для модели.
 *
 * Схема уходит ОДНОЙ строкой без отступов: она едет в каждом запросе, а
 * красивый JSON у полутора десятков инструментов Claude Code стоит лишних
 * тысяч знаков на каждый ход — цена, которую платит человек.
 */
export function renderToolList(tools: readonly ShimTool[]): string {
  const lines = ['Список инструментов:', ''];
  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    if (tool.description) lines.push(tool.description);
    lines.push(`Аргументы: ${JSON.stringify(tool.schema ?? {})}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Добавка к системной строке: правила протокола плюс список инструментов.
 *
 * Пусто, если инструментов нет: протокол без списка — это обещание модели, что
 * руки у неё есть, и прямая дорога к выдуманному вызову несуществующего
 * инструмента.
 */
export function systemAddendum(protocolText: string, tools: readonly ShimTool[]): string {
  // compromise: shim-no-cache — правила и схемы пересобираются на КАЖДЫЙ ход и
  // едут в каждом запросе: у платформы нет кэша промпта, и уменьшить эту цену
  // можно только урезав набор инструментов.
  if (tools.length === 0) return '';
  const rules = protocolText.trim();
  return [rules, renderToolList(tools)].filter(Boolean).join('\n\n');
}
