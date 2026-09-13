/**
 * Каталоги моделей в формах настоящих шлюзов (DRV-06).
 *
 * Каждая форма — то, что шлюз отдаёт на `GET …/models`, а не выдуманная таблица
 * полей: OpenRouter снят живым ответом 13.09.2026 (у записей срезаны только
 * `description` и `benchmarks`), платформа компании — по `mod-llmbox/src/llmbox/api/models.py:21-43`,
 * остальные — по опубликованной документации шлюза. Проверяются они через
 * `probePlatform`, то есть тем путём, которым идёт кнопка «Проверить».
 */

/** Together: голый массив вместо `{ data }`, вид в `type`. */
export const TOGETHER_MODELS = [
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    object: 'model',
    created: 1733443200,
    type: 'chat',
    display_name: 'Meta Llama 3.3 70B Instruct Turbo',
    organization: 'Meta',
    context_length: 131072,
  },
  {
    id: 'BAAI/bge-large-en-v1.5',
    object: 'model',
    created: 1700000000,
    type: 'embedding',
    display_name: 'BAAI-Bge-Large-1p5',
    organization: 'BAAI',
    context_length: 512,
  },
];

/** vLLM: окно контекста в `max_model_len`, вида нет вовсе. */
export const VLLM_MODELS = {
  object: 'list',
  data: [
    {
      id: 'Qwen/Qwen3-8B',
      object: 'model',
      created: 1757750000,
      owned_by: 'vllm',
      root: 'Qwen/Qwen3-8B',
      parent: null,
      max_model_len: 32768,
      permission: [],
    },
  ],
};

/** Azure OpenAI: вид объявлен булевыми возможностями. */
export const AZURE_MODELS = {
  data: [
    {
      id: 'gpt-4o-2024-08-06',
      status: 'succeeded',
      capabilities: {
        fine_tune: true,
        inference: true,
        completion: true,
        chat_completion: true,
        embeddings: false,
      },
      lifecycle_status: 'generally-available',
      object: 'model',
    },
    {
      id: 'text-embedding-3-large',
      status: 'succeeded',
      capabilities: {
        fine_tune: false,
        inference: true,
        completion: false,
        chat_completion: false,
        embeddings: true,
      },
      lifecycle_status: 'generally-available',
      object: 'model',
    },
  ],
};

/** Mistral: `type: "base"` — не вид; вид и окно рядом в `capabilities` и `max_context_length`. */
export const MISTRAL_MODELS = {
  object: 'list',
  data: [
    {
      id: 'mistral-large-latest',
      object: 'model',
      owned_by: 'mistralai',
      capabilities: {
        completion_chat: true,
        completion_fim: false,
        function_calling: true,
        fine_tuning: false,
        vision: false,
        classification: false,
      },
      name: 'mistral-large-2411',
      max_context_length: 131072,
      type: 'base',
    },
  ],
};

/** OpenRouter: списки возможностей, потолок у провайдера, цены строками за токен. */
export const OPENROUTER_MODELS = {
  data: [
    {
      id: 'openai/gpt-4o-mini',
      canonical_slug: 'openai/gpt-4o-mini',
      hugging_face_id: null,
      name: 'OpenAI: GPT-4o-mini',
      created: 1721260800,
      context_length: 128000,
      architecture: {
        modality: 'text+image+file->text',
        input_modalities: ['text', 'image', 'file'],
        output_modalities: ['text'],
        tokenizer: 'GPT',
        instruct_type: null,
      },
      pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000075' },
      top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: true },
      per_request_limits: null,
      supported_parameters: [
        'frequency_penalty',
        'logit_bias',
        'logprobs',
        'max_completion_tokens',
        'max_tokens',
        'prediction',
        'presence_penalty',
        'response_format',
        'seed',
        'stop',
        'structured_outputs',
        'temperature',
        'tool_choice',
        'tools',
        'top_logprobs',
        'top_p',
        'web_search_options',
      ],
      default_parameters: {},
      supported_voices: null,
      knowledge_cutoff: '2023-10-31',
      expiration_date: null,
      links: { details: '/api/v1/models/openai/gpt-4o-mini/endpoints' },
    },
    {
      id: 'google/gemini-2.5-flash-image',
      canonical_slug: 'google/gemini-2.5-flash-image',
      hugging_face_id: '',
      name: 'Google: Nano Banana (Gemini 2.5 Flash Image)',
      created: 1759870431,
      context_length: 32768,
      architecture: {
        modality: 'text+image->text+image',
        input_modalities: ['image', 'text'],
        output_modalities: ['image', 'text'],
        tokenizer: 'Gemini',
        instruct_type: null,
      },
      pricing: {
        prompt: '0.0000003',
        completion: '0.0000025',
        image: '0.0000003',
        image_output: '0.00003',
        input_cache_read: '0.00000003',
        input_cache_write: '0.0000000833333333333333',
      },
      top_provider: { context_length: 32768, max_completion_tokens: 8192, is_moderated: false },
      per_request_limits: null,
      supported_parameters: [
        'max_tokens',
        'response_format',
        'seed',
        'stop',
        'structured_outputs',
        'temperature',
        'top_p',
      ],
    },
    {
      id: 'openrouter/auto',
      canonical_slug: 'openrouter/auto',
      hugging_face_id: null,
      name: 'Auto Router',
      created: 1699401600,
      context_length: 2000000,
      architecture: {
        modality: 'text+image+file+audio+video->text+image',
        input_modalities: ['text', 'image', 'audio', 'file', 'video'],
        output_modalities: ['text', 'image'],
        tokenizer: 'Router',
        instruct_type: null,
      },
      pricing: { prompt: '-1', completion: '-1' },
      top_provider: { context_length: null, max_completion_tokens: null, is_moderated: false },
      per_request_limits: null,
      supported_parameters: ['include_reasoning', 'reasoning', 'tools', 'response_format'],
    },
  ],
};

/** Платформа компании: вид и возможности, объявленные схемой `Model` контура. */
export const ENTERPRISE_PLATFORM_MODELS = {
  object: 'list',
  data: [
    {
      id: 'enterprise-platform-corp-l',
      object: 'model',
      owned_by: 'enterprise-platform',
      kind: 'chat',
      capabilities: {
        vision: false,
        function_calling: true,
        json_mode: true,
        image_generation: false,
      },
    },
    {
      id: 'ru-embed-v2',
      object: 'model',
      owned_by: 'enterprise-platform',
      kind: 'embedding',
      capabilities: {
        vision: false,
        function_calling: false,
        json_mode: false,
        image_generation: false,
      },
    },
  ],
};
