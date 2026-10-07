// Module of the prompt dispatcher: a figma.com link in
// the message → remind the model about the figma-parity skill and the real-Figma-MCP-only rule.
// Contract: (input, prompt) → string | null.
export default function figmaHint(_input, prompt) {
  if (!/figma\.com\//i.test(prompt)) return null;
  return (
    'Figma link in the message. If the task is bringing the front to the design — use the skill agentdeck-kit:figma-parity. ' +
    'Figma work goes through the real Figma MCP (Dev Mode) only; if its tools are absent from the session, ' +
    'tell the user to start desktop Figma / reconnect the MCP.'
  );
}
