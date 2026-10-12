import type {
  ProjectTestAutomationCommand,
  ProjectTestAutomationRecipe,
} from '@agentdeck/contracts';

export interface TestAutomationCommandProps {
  path: string | undefined;
  /** Записанная команда из вида раздела; нет — проект её ещё не назвал. */
  automation?: ProjectTestAutomationCommand;
  /** Идёт прогон автотестов: он гонит прежнюю строку, менять её сейчас нельзя. */
  isLocked: boolean;
  /**
   * У проекта есть папка e2e: своя команда тогда — запасной путь, и без
   * рецептов карточка не объясняет её тремя строками, а даёт одну кнопку.
   */
  hasFolder: boolean;
}

export interface TestAutomationRecipesProps {
  recipes: ProjectTestAutomationRecipe[];
  disabled: boolean;
  onTake: (recipe: ProjectTestAutomationRecipe) => void;
}
