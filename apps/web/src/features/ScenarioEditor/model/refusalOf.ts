/**
 * Отказ ядра на запись или правку сценария, прочитанный из ошибки запроса (axios:
 * `response.status` + тело `{code, error|reason, problems?, next?}`). Код решает, какие слова
 * увидит человек: `signature-required` — звено панели не подтверждено, нужна подпись телефона;
 * `version-taken` — версия занята, есть следующая; прочее — причина ядра как есть.
 */
export interface ScenarioRefusal {
  status: number | undefined;
  code: string;
  reason: string;
  problems: string[];
  /** Следующая свободная версия, если ядро её назвало. */
  next: number | undefined;
}

export function refusalOf(error: unknown): ScenarioRefusal | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
  const body = response?.data;
  if (typeof body !== 'object' || body === null) return undefined;
  const data = body as Record<string, unknown>;
  if (typeof data.code !== 'string') return undefined;
  const text = typeof data.reason === 'string' ? data.reason : data.error;
  return {
    status: typeof response?.status === 'number' ? response.status : undefined,
    code: data.code,
    reason: typeof text === 'string' ? text : '',
    problems: Array.isArray(data.problems)
      ? data.problems.filter((p): p is string => typeof p === 'string')
      : [],
    next: typeof data.next === 'number' ? data.next : undefined,
  };
}

/** Коды со своими словами в словаре редактора; остальные показываются причиной ядра. */
export const KNOWN_REFUSALS = [
  'signature-required',
  'forged-authority',
  'nonce-invalid',
  'proof-required',
  'version-taken',
  'version-gap',
  'version-mismatch',
  'preset-id-reserved',
  'invalid-scenario',
  'state-conflict',
] as const;
export type KnownRefusal = (typeof KNOWN_REFUSALS)[number];

export function knownRefusal(code: string): KnownRefusal | undefined {
  return (KNOWN_REFUSALS as readonly string[]).includes(code) ? (code as KnownRefusal) : undefined;
}

/**
 * Отказ для показа: тело ядра, если оно есть, иначе сбой запроса своими словами (сеть, прокладка
 * без тела). Кнопка, вызвавшая запрос, никогда не остаётся без ответа.
 */
export function failureOf(error: unknown): ScenarioRefusal {
  return (
    refusalOf(error) ?? {
      status: undefined,
      code: 'request-failed',
      reason: error instanceof Error ? error.message : String(error),
      problems: [],
      next: undefined,
    }
  );
}
