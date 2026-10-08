import { EXPANDED_BRANCHES_KEY } from '../model/expandedBranches.constants';

export function writeExpandedBranches(expanded: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(EXPANDED_BRANCHES_KEY, JSON.stringify([...expanded]));
  } catch {
    // Не запомнилось — при следующем открытии ветвь просто свёрнута.
  }
}
