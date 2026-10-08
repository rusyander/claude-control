import type {
  ChatGroupSettingsView,
  StoredChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';

/**
 * Своё у чата из действующего вида: унаследованное поле своим не считается —
 * иначе первый же щелчок у ребёнка «приклеил» бы родительское значение, и
 * правка у родителя до ребёнка больше не доходила бы.
 */
export function ownSettings(view: ChatGroupSettingsView | undefined): StoredChatGroupSettings {
  if (!view) return {};
  return {
    ...(view.groupChoiceInherited ? {} : { groupChoice: view.groupChoice }),
    ...(view.autonomousInherited ? {} : { autonomous: view.autonomous }),
  };
}
