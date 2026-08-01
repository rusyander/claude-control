import type { ConfigProvider } from './types.ts';
import { aiderProvider } from './catalog/aider.ts';
import { codexProvider } from './catalog/codex.ts';
import { continueProvider } from './catalog/continue.ts';
import { cursorProvider } from './catalog/cursor.ts';
import { geminiProvider } from './catalog/gemini.ts';
import { gooseProvider } from './catalog/goose.ts';
import { kimiProvider } from './catalog/kimi.ts';
import { opencodeProvider } from './catalog/opencode.ts';
import { qwenProvider } from './catalog/qwen.ts';

/**
 * Каталог экспериментальных провайдеров — источник истины по их возможностям.
 * Путь `providers/catalog.ts` остаётся публичным (реестр, домены, тесты), а
 * объявления разъехались по `catalog/`: файл на провайдера плюс `config-dirs.ts`
 * с задокументированными переопределениями каталогов и fail-closed `paths`.
 *
 * Меняешь возможности — обнови и `.agent/universal-providers.agent.md`, README,
 * docs/PROVIDERS и справку панели (список в конце того же документа).
 */

export {
  AIDER_CONFIG_BASENAME,
  aiderConfigFile,
  codexHome,
  continueHome,
  gooseConfigDir,
  kimiCodeHome,
  opencodeConfigDir,
  opencodeConfigFile,
  qwenHome,
} from './catalog/config-dirs.ts';

/**
 * Экспериментальные провайдеры в порядке отображения. Claude в этот список не
 * входит — он подмешивается реестром первым как проверенный провайдер-дефолт.
 */
export const CATALOG_PROVIDERS: ConfigProvider[] = [
  codexProvider,
  geminiProvider,
  qwenProvider,
  continueProvider,
  gooseProvider,
  kimiProvider,
  cursorProvider,
  opencodeProvider,
  aiderProvider,
];
