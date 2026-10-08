import type { Platform } from '@agentdeck/contracts';
import {
  PLATFORM_DEFAULT_CONSUMERS,
  PLATFORM_PRESETS,
  defaultPlatformRules,
  defaultOurRules,
  defaultPlatformTransport,
} from '@agentdeck/contracts';

/** Новый контур с заполненными по умолчанию полями. */
export function newPlatform(id: string, title: string): Platform {
  return {
    id,
    title,
    driver: 'enterprise-platform',
    baseUrl: '',
    // Выключенным: включает его человек в конце мастера, увидев, что панель
    // нашла. Включённый по умолчанию контур применился бы до первой пробы.
    enabled: false,
    mode: 'required',
    budgetUsd: 0,
    capabilities: [],
    targets: [],
    // Где работает контур (Т3): только ассистент панели. Прослойка Т5 вернула
    // CLI руки, но выбор «куда пустить контур» остаётся за человеком: молча
    // увести туда рабочий чат значило бы сменить ему модель, ничего не сказав.
    consumers: [...PLATFORM_DEFAULT_CONSUMERS],
    projectPaths: [],
    // Модель (Т6) — пустой: каталог появится только после первой пробы, и
    // выбирать её из пустого списка человеку нечем. До выбора панель берёт
    // первую чатовую модель каталога и говорит, что выбор не его.
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    // Агентов человек вносит сам и уже после подключения: их идентификаторы
    // лежат в админке компании, и спросить их у контура нечем.
    agents: [],
    budgetSince: '',
    // Прослойка инструментов и короткий промпт — по пресету драйвера: у платформы компании
    // включёнными (решение В1, без них агент через неё «работает как чат»), у
    // совместимого шлюза — нет, инструменты он принимает полем (аудит DRV-20).
    ...PLATFORM_PRESETS['enterprise-platform'].defaults,
    // Правила контура (Т7) — умолчаниями контракта: список инструментов
    // платформы пуст, и пока он пуст, наверх уходит `tool_choice: "none"`.
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    // Транспорт — как было до DRV-04/05: ключ в `Authorization: Bearer`, `/v1`
    // дописывается к адресу без версии. Нестандартный шлюз правится на шаге адреса.
    transport: defaultPlatformTransport(),
  };
}
