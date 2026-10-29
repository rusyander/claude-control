import type {
  ChannelBypass,
  CliRunFacts,
  Dialect,
  EndpointApiKind,
  EnvRunChannel,
  EnvVarsChannel,
  FileChannel,
} from './types.ts';

/** Вид API своего эндпоинта по диалекту: чат и responses OpenAI — оба «совместимые с OpenAI». */
export function endpointApiKindOf(dialect: Dialect): EndpointApiKind {
  if (dialect === 'anthropic-messages') return 'anthropic';
  if (dialect === 'google-genai') return 'google';
  return 'openai-compat';
}

/**
 * Ручка совместимого с OpenAI адреса: Continue идёт в `/chat/completions`, Codex с тех пор,
 * как снял `wire_api = "chat"`, — только в `/responses`.
 */
export function wireApiOf(dialect: Dialect): 'chat' | 'responses' {
  return dialect === 'openai-responses' ? 'responses' : 'chat';
}

/** Название настройки для отказа: имя и, если задано, значение, которого она требует. */
export function bypassLabel(bypass: ChannelBypass): string {
  return bypass.requires === undefined
    ? bypass.setting
    : `${bypass.setting} ≠ "${bypass.requires}"`;
}

/**
 * Имя модели, когда маршрут своей не назвал. Пустым его оставить нельзя: без имени Kimi не
 * заводит модель из окружения и уходит к модели по умолчанию из конфига человека, то есть
 * мимо контура (живая проба 2.1.1). Имя уходит как есть — что с ним делать, решает маршрут.
 */
const UNNAMED_ROUTE_MODEL = 'default';

export const contourModelName = (model: string): string => model.trim() || UNNAMED_ROUTE_MODEL;

/** Каналы тройкой переменных, в объявленном порядке (он же порядок видов API у панели). */
export function envVarsChannels(facts: CliRunFacts): EnvVarsChannel[] {
  return facts.channels.filter(
    (channel): channel is EnvVarsChannel => channel.via === 'env' && channel.form === 'vars',
  );
}

/** Канал окружением одного прогона; у CLI он один или его нет. */
export function envRunChannel(facts: CliRunFacts): EnvRunChannel | undefined {
  return facts.channels.find(
    (channel): channel is EnvRunChannel => channel.via === 'env' && channel.form === 'run',
  );
}

/** Канал куском собственного конфига; у CLI он один или его нет. */
export function fileChannel(facts: CliRunFacts): FileChannel | undefined {
  return facts.channels.find((channel): channel is FileChannel => channel.via === 'file');
}
