import type { panelActionsChatSandboxAgentsRu } from './actions-chat-sandbox-agents.ru.ts';

/** English titles of the P3 actions (U5c); keys follow the Russian module. */
export const panelActionsChatSandboxAgentsEn: Record<
  keyof typeof panelActionsChatSandboxAgentsRu,
  string
> = {
  continue_chat_handoff: 'Continue the chat in a new session',
  restart_chat_session: 'Restart the chat session',
  list_chat_artifacts: 'Chat files',
  read_chat_artifact: 'Read a chat file',
  delete_chat_artifact: 'Delete a chat file',
  open_project_in_editor: 'Open the project in an editor',
  list_sandbox_fixtures: 'Sandbox event fixtures',
  sandbox_probe_hook: 'Run a hook in the sandbox',
  sandbox_ask: 'Ask Claude in the sandbox',
  ask_contour_agent: 'Ask a contour agent',
  read_contour_agent_session: 'Contour agent session',
  reset_contour_agent_session: 'Reset a contour agent session',
  contour_embeddings: 'Contour embeddings',
};
