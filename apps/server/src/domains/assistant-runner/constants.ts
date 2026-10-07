/** Таймаут CLI one-shot по умолчанию, мс. */
export const DEFAULT_TIMEOUT = 180_000;

/**
 * Облака вендоров для прямого вызова. Каждое — только своему виду API: OpenAI —
 * виду `openai`, Anthropic — одному `claude` (`vendorApiRefusal`). Запасным
 * адресом для `openai-compat` облако OpenAI не служит: ключ ушёл бы чужому вендору.
 */
export const OPENAI_BASE = 'https://api.openai.com/v1';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Зашитый минимум: скромные модели, которых хватает на заполнение формы.
 * Каталог поколений (`deps.models`) поднимает каждую до её актуальной версии
 * ВНУТРИ семейства — класс модели и порядок цены остаются те же.
 */
export const MODELS = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  google: 'gemini-1.5-flash',
} as const;
