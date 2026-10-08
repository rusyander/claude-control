/** Замена хука и MCP приходит JSON в одну строку — человеку показываем с отступами. */
export function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
