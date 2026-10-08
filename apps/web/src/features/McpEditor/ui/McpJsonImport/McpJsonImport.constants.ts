/** Пример конфига в поле ввода: показывает обе понимаемые формы записи. */
export const PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
    },
    "sentry": { "url": "https://mcp.sentry.dev/sse" }
  }
}`;
