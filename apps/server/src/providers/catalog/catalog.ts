import type { ConfigProvider } from '../types/types.ts';
import { aiderProvider } from './aider.ts';
import { codexProvider } from './codex.ts';
import { continueProvider } from './continue.ts';
import { cursorProvider } from './cursor.ts';
import { geminiProvider } from './gemini.ts';
import { gooseProvider } from './goose.ts';
import { kimiProvider } from './kimi.ts';
import { opencodeProvider } from './opencode.ts';
import { qwenProvider } from './qwen.ts';

/**
 * Каталог экспериментальных провайдеров — источник истины по их возможностям.
 * Путь `providers/catalog/catalog.ts` остаётся публичным (реестр, домены, тесты), а
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
} from './config-dirs.ts';

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
