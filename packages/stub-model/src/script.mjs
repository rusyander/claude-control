/**
 * Сценарий заглушки: какой шаг отдать на очередной модельный запрос.
 *
 *   script: Step[] | StepFn | { rules?, steps?, fallback? }
 *
 * Порядок: первое правило `rules`, чьё `when` сработало (строка — метка где-то в
 * сыром теле, RegExp — по сырому телу, функция — по контексту) и у которого не
 * кончились `times`; иначе `steps` — массив по своему курсору или функция
 * (`ctx.index` — номер модельного запроса с нуля, `ctx.bodies` — сырые тела всех
 * запросов, включая текущий: так шаг строится из прошлых запросов); иначе `fallback`
 * (по умолчанию текст «DONE»). Функция вернула `null`/`undefined` — тоже `fallback`.
 */

const SCRIPT_KEYS = new Set(['rules', 'steps', 'fallback']);
const STEP_KEYS = new Set([
  'text',
  'tool',
  'tools',
  'custom',
  'error',
  'holdMs',
  'stallMs',
  'window',
  'headers',
  'usage',
  'extra',
  'model',
]);

/**
 * Шаг-данные проверяется при запуске: опечатка (`eror`, `texts`) иначе стартовала бы и
 * ответила 200 «STUB SCRIPT FAILED» — проверка, ждущая 429, прошла бы по тексту (F-75).
 * Шаг-функция проверяется на запросе — её результат известен только там.
 */
function checkAtStart(step, where) {
  if (typeof step === 'function') return;
  try {
    normalizeStep(step);
  } catch (error) {
    throw new TypeError(`stub-model: ${where}: ${error.message.replace(/^stub-model: /, '')}`, {
      cause: error,
    });
  }
}

/** Сколько раз правило срабатывает: целое ≥ 1 или `Infinity`; 0 и меньше — мёртвое правило. */
function ruleTimes(times, at) {
  if (times === undefined || times === Infinity) return Infinity;
  if (!Number.isInteger(times) || times < 1)
    throw new TypeError(`stub-model: rules[${at}].times must be an integer ≥ 1`);
  return times;
}

/** Сценарий в одну форму; ошибка формы — сразу, при запуске заглушки, а не на запросе. */
export function compileScript(script) {
  const spec =
    script === undefined
      ? {}
      : typeof script === 'function' || Array.isArray(script)
        ? { steps: script }
        : script;
  if (typeof spec !== 'object' || spec === null)
    throw new TypeError('stub-model: script must be an array, a function or an object');
  for (const key of Object.keys(spec))
    if (!SCRIPT_KEYS.has(key)) throw new TypeError(`stub-model: unknown script key «${key}»`);
  if (spec.steps !== undefined && typeof spec.steps !== 'function' && !Array.isArray(spec.steps))
    throw new TypeError('stub-model: script.steps must be an array or a function');
  if (spec.rules !== undefined && !Array.isArray(spec.rules))
    throw new TypeError('stub-model: script.rules must be an array');
  if (Array.isArray(spec.steps))
    for (const [at, step] of spec.steps.entries()) checkAtStart(step, `steps[${at}]`);
  const rules = (spec.rules ?? []).map((rule, at) => {
    const when = rule?.when;
    if (typeof when !== 'string' && !(when instanceof RegExp) && typeof when !== 'function')
      throw new TypeError(`stub-model: rules[${at}].when must be a string, a RegExp or a function`);
    if (rule.step === undefined) throw new TypeError(`stub-model: rules[${at}].step is missing`);
    checkAtStart(rule.step, `rules[${at}].step`);
    return { when, step: rule.step, left: ruleTimes(rule.times, at) };
  });
  // Запасной шаг — данные (типы запрещают функцию): функция здесь дала бы «STUB SCRIPT
  // FAILED» на запросе, а не отказ при запуске.
  if (typeof spec.fallback === 'function')
    throw new TypeError('stub-model: script.fallback must be a step, not a function');
  if (spec.fallback !== undefined) checkAtStart(spec.fallback, 'fallback');
  const fallback = spec.fallback ?? { text: 'DONE' };
  let cursor = 0;

  const matches = (when, ctx) => {
    if (typeof when === 'string') return ctx.request.raw.includes(when);
    if (when instanceof RegExp) {
      when.lastIndex = 0;
      return when.test(ctx.request.raw);
    }
    return Boolean(when(ctx));
  };
  const pick = async (step, ctx) =>
    (await (typeof step === 'function' ? step(ctx) : step)) ?? fallback;

  return async (ctx) => {
    for (const rule of rules) {
      if (rule.left > 0 && matches(rule.when, ctx)) {
        rule.left -= 1;
        return pick(rule.step, ctx);
      }
    }
    if (typeof spec.steps === 'function') return pick(spec.steps, ctx);
    if (Array.isArray(spec.steps) && cursor < spec.steps.length)
      return pick(spec.steps[cursor++], ctx);
    return fallback;
  };
}

/** Задержка, мс: число ≥ 0; `Infinity` — держать до `release()`/`close()`/ухода клиента. */
const nonNegative = (value, name) => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !(value >= 0))
    throw new TypeError(`stub-model: ${name} must be a number ≥ 0`);
  return value;
};

/** Конечное число ≥ 0 (секунды `retry-after`, расход): `Infinity`/NaN ушли бы в провод текстом. */
const finiteNonNegative = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new TypeError(`stub-model: ${name} must be a number ≥ 0, finite`);
  return value;
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Только известные ключи: опечатка в подобъекте иначе молча теряет поле. */
function knownKeys(value, keys, name) {
  if (!isPlainObject(value)) throw new TypeError(`stub-model: ${name} must be an object`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new TypeError(`stub-model: unknown ${name} key «${key}»`);
}

const optionalString = (value, name) => {
  if (value !== undefined && typeof value !== 'string')
    throw new TypeError(`stub-model: ${name} must be a string`);
};

const WINDOW_STATUS = ['allowed', 'allowed_warning', 'rejected'];
const WINDOW_CLAIM = ['five_hour', 'seven_day'];

function checkWindow(window) {
  if (window === undefined) return undefined;
  knownKeys(window, ['utilization', 'resetsAt', 'status', 'claim'], 'step.window');
  if (window.utilization !== undefined)
    finiteNonNegative(window.utilization, 'step.window.utilization');
  if (window.resetsAt !== undefined) finiteNonNegative(window.resetsAt, 'step.window.resetsAt');
  if (window.status !== undefined && !WINDOW_STATUS.includes(window.status))
    throw new TypeError(
      `stub-model: step.window.status must be one of ${WINDOW_STATUS.join(', ')}`,
    );
  if (window.claim !== undefined && !WINDOW_CLAIM.includes(window.claim))
    throw new TypeError(`stub-model: step.window.claim must be one of ${WINDOW_CLAIM.join(', ')}`);
  return window;
}

/** Свои заголовки: объект строк (числа — тоже, их пишет Node); строка дала бы заголовки «0», «1». */
function checkHeaders(headers) {
  if (headers === undefined) return {};
  if (!isPlainObject(headers)) throw new TypeError('stub-model: step.headers must be an object');
  for (const [name, value] of Object.entries(headers))
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
      throw new TypeError(`stub-model: step.headers.${name} must be a string`);
  return headers;
}

function checkUsage(usage) {
  if (usage === undefined) return {};
  if (!isPlainObject(usage)) throw new TypeError('stub-model: step.usage must be an object');
  for (const field of ['input', 'output', 'cached'])
    if (usage[field] !== undefined) finiteNonNegative(usage[field], `step.usage.${field}`);
  return usage;
}

const toolPart = (tool, name) => {
  knownKeys(tool, ['name', 'args', 'id'], name);
  optionalString(tool.id, `${name}.id`);
  if (typeof tool?.name !== 'string' || !tool.name)
    throw new TypeError(`stub-model: ${name}.name is required`);
  return {
    kind: 'tool',
    name: tool.name,
    args: tool.args ?? {},
    ...(tool.id ? { id: tool.id } : {}),
  };
};

/**
 * Шаг в одну форму: части ответа по порядку (текст, вызовы функций, свободный
 * инструмент) или ошибка, плюс задержки, окно, свои заголовки, расход и `extra` —
 * поля сверх протокола в итоговом объекте ответа (`timings` у llama-server).
 */
export function normalizeStep(step) {
  if (typeof step === 'string') step = { text: step };
  if (typeof step !== 'object' || step === null)
    throw new TypeError('stub-model: a step must be an object');
  for (const key of Object.keys(step))
    if (!STEP_KEYS.has(key)) throw new TypeError(`stub-model: unknown step key «${key}»`);
  const parts = [];
  if (step.text !== undefined) {
    // Массив строк — один текстовый блок, отданный в потоке несколькими дельтами
    // (так модель стримит на деле; разбор у клиента обязан склеить их сам).
    const chunks = typeof step.text === 'string' ? [step.text] : step.text;
    if (!Array.isArray(chunks) || !chunks.length || chunks.some((c) => typeof c !== 'string'))
      throw new TypeError('stub-model: step.text must be a string or a non-empty string array');
    parts.push({ kind: 'text', text: chunks.join(''), chunks });
  }
  if (step.tool !== undefined) parts.push(toolPart(step.tool, 'step.tool'));
  if (step.tools !== undefined && !Array.isArray(step.tools))
    throw new TypeError('stub-model: step.tools must be an array');
  for (const [at, tool] of (step.tools ?? []).entries())
    parts.push(toolPart(tool, `step.tools[${at}]`));
  if (step.custom !== undefined) {
    knownKeys(step.custom, ['name', 'input', 'id'], 'step.custom');
    optionalString(step.custom.id, 'step.custom.id');
    if (typeof step.custom?.name !== 'string' || typeof step.custom.input !== 'string')
      throw new TypeError('stub-model: step.custom needs a name and a string input');
    parts.push({
      kind: 'custom',
      name: step.custom.name,
      input: step.custom.input,
      ...(step.custom.id ? { id: step.custom.id } : {}),
    });
  }
  let error;
  if (step.error !== undefined) {
    knownKeys(
      step.error,
      ['status', 'message', 'retryAfter', 'midStream', 'type', 'code'],
      'step.error',
    );
    const status = step.error.status;
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new TypeError('stub-model: step.error.status must be an HTTP error status');
    for (const field of ['message', 'type', 'code'])
      optionalString(step.error[field], `step.error.${field}`);
    if (step.error.midStream !== undefined && typeof step.error.midStream !== 'boolean')
      throw new TypeError('stub-model: step.error.midStream must be a boolean');
    // Ошибка посреди потока идёт сразу за началом ответа: частей у шага-ошибки нет.
    if (parts.length) throw new TypeError('stub-model: an error step carries no reply parts');
    error = {
      status,
      message: step.error.message ?? `stub-model: scripted ${status}`,
      midStream: step.error.midStream === true,
      ...(step.error.retryAfter !== undefined
        ? { retryAfter: finiteNonNegative(step.error.retryAfter, 'step.error.retryAfter') }
        : {}),
      ...(step.error.type ? { type: step.error.type } : {}),
      ...(step.error.code ? { code: step.error.code } : {}),
    };
  }
  if (!parts.length && !error)
    throw new TypeError('stub-model: a step needs text, tool, tools, custom or error');
  const extra = step.extra ?? {};
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra))
    throw new TypeError('stub-model: step.extra must be an object of reply fields');
  const usage = checkUsage(step.usage);
  optionalString(step.model, 'step.model');
  return {
    parts,
    error,
    ...(step.model ? { model: step.model } : {}),
    holdMs: nonNegative(step.holdMs, 'step.holdMs'),
    stallMs: nonNegative(step.stallMs, 'step.stallMs'),
    window: checkWindow(step.window),
    headers: checkHeaders(step.headers),
    extra,
    usage: {
      input: usage.input ?? 10,
      output: usage.output ?? 2,
      cached: usage.cached ?? 0,
    },
  };
}

/** Короткая подпись ответа для следа и `requests[].reply`. */
export function replyLabel(step) {
  if (step.error) return `error:${step.error.status}${step.error.midStream ? ':mid-stream' : ''}`;
  return step.parts
    .map((part) => (part.kind === 'text' ? part.text : `${part.kind}:${part.name}`))
    .join(' + ');
}
