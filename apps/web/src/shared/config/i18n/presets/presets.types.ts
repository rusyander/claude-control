/** Название и пояснение одной заготовки. */
export interface PresetText {
  title: string;
  description: string;
}

/** Заготовка хука: ещё и текст сообщения, которым она заполняет поле. */
export interface HookPresetText extends PresetText {
  message?: string;
}

/** Событие хука: когда срабатывает и для чего его берут. */
export interface HookEventText {
  when: string;
  useFor: string;
}

/**
 * Словарь заготовок по id. Записи необязательные: русский текст живёт в самой
 * заготовке (contracts, `HookEditor/model/hookPresets.ts`) и приходит в `t()`
 * как `defaultValue`, а полноту английского держит тест словаря.
 */
export interface PresetsDictionary {
  permission: Partial<Record<string, PresetText>>;
  mcp: Partial<Record<string, PresetText>>;
  hook: Partial<Record<string, HookPresetText>>;
  hookEvent: Partial<Record<string, HookEventText>>;
}
