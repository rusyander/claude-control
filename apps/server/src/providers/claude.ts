import { CLAUDE_HOOK_EVENTS } from '@agentdeck/contracts/vocabulary';
import {
  GROUP_ECONOMY_LEVERS,
  type GroupEconomySupport,
} from '@agentdeck/contracts/group-economy-support';
import { detectClaudeLocation } from '../lib/claude-paths/claude-paths.ts';
import { assistantApiOf, endpointConfigOf, modelsOf, runFactsOf } from './catalog/run-facts.ts';
import { uniformCapabilities, type ConfigProvider } from './types/types.ts';

/** Факты запуска Claude Code — из пакета `@agentdeck/providers`, здесь не объявляются. */
const facts = runFactsOf('claude');

/**
 * Адаптер Claude Code — провайдер #1. Поведение панели не меняется: пути
 * делегируются существующему `lib/claude-paths/claude-paths.ts`, а не дублируются, CLI —
 * `claude` (на Windows `claude.cmd`). Статус `verified`, а все возможности —
 * `ready`: у Claude каждый раздел панели реально работает.
 */
export const claudeProvider: ConfigProvider = {
  id: facts.id,
  name: facts.name,
  status: facts.status,
  paths: (override) => detectClaudeLocation(override).paths,
  cli: facts.binary,
  capabilities: uniformCapabilities('ready'),
  // Рычаги экономии групп придуманы на Claude и все доходят его собственными
  // ключами (`group-profile.ts`): канала диспетчера ему не нужно.
  groupEconomy: {
    support: Object.fromEntries(
      GROUP_ECONOMY_LEVERS.map((lever) => [lever, { support: 'native' }]),
    ) as GroupEconomySupport,
  },
  // Все разделы Claude — СОБСТВЕННАЯ модель панели на своих маршрутах, поэтому
  // ни одного универсального `*Config` у него нет. Матрица верности (П1.1)
  // считает по каталогу, и без этого блока она решила бы, что в Claude не
  // переносится ничего. События хуков берутся из справочника контрактов — того
  // же словаря, которым живёт раздел хуков (совпадение сторожит тест).
  nativeMechanisms: {
    hookEvents: CLAUDE_HOOK_EVENTS.map((info) => ({ name: info.name, blocking: info.blocking })),
    permissions: { model: 'rules', decisions: ['allow', 'ask', 'deny'] },
    skills: true,
    commands: true,
    subagents: true,
    mcp: true,
    env: true,
    plugins: true,
  },
  // Файл инструкций — тот же CLAUDE.md, что и раздел «Правила»; уважает
  // пользовательский каталог (override/env), поэтому делегируем детекту, а не
  // хардкодим ~/.claude. Поведение раздела не меняется (регресс-ноль).
  instructionsFile: (override) => detectClaudeLocation(override).paths.claudeMd,
  // Детект «конфиг найден» (Ф7): корень каталога конфигурации Claude. Уважает
  // пользовательский путь (override/env) — как и остальные разделы, поэтому идём
  // через тот же детект расположения, а не через хардкод ~/.claude.
  configLocations: (override) => [detectClaudeLocation(override).paths.root],
  // Ассистент Claude: API — Anthropic (ключ ANTHROPIC_API_KEY), но у него есть
  // рабочий CLI-путь (`claude`), поэтому при отсутствии ключа, но найденном CLI
  // раннер = `cli` — текущее поведение чата сохраняется (регресс-ноль).
  assistant: assistantApiOf(facts),
  // Свой эндпоинт (шлюз организации, прокси, локальная модель): задокументирован
  // `ANTHROPIC_BASE_URL` — «the variable that points Claude Code at the gateway»,
  // — плюс `ANTHROPIC_MODEL` для выбора модели. Токен документация предлагает
  // класть в `ANTHROPIC_AUTH_TOKEN` (уходит заголовком `Authorization: Bearer`);
  // это же значение по умолчанию советуют, когда вид учётки неизвестен, а
  // `ANTHROPIC_API_KEY` (заголовок `x-api-key`) требует ещё и одобрения в
  // интерактивной сессии. Всё это пишется в блок `env` файла settings.json —
  // ровно туда, куда указывает документация шлюзов.
  endpointConfig: endpointConfigOf(facts),
  // Модели: каталог Anthropic (models.dev). Алиасы (`opus`, `sonnet`, `haiku`)
  // CLI разворачивает сам, поэтому каталог нужен ровно для двух вещей — видеть
  // вышедшие модели и заметить смену поколения у пришпиленного дефолта.
  ...modelsOf(facts),
};
