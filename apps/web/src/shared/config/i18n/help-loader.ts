import { type Language } from './instance';
import { helpReady } from './help-loader.constants';

export function hasHelp(language: Language): boolean {
  return helpReady.has(language);
}
