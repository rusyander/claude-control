/**
 * Фасад файлов-блоков MCP у Continue: сам код лежит в `provider-mcp/blocks.ts`
 * рядом с остальным разделом.
 */
export {
  scanMcpBlocks,
  findBlockOf,
  type McpBlockFile,
  type McpBlockScan,
  type SkippedMcpBlock,
} from './provider-mcp/blocks.ts';
