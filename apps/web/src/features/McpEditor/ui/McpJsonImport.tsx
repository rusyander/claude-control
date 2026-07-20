import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { McpServerDraft } from '@claude-control/contracts';
import { mcpServerApi } from '@entities/McpServer';
import type { McpJsonImportProps } from './McpJsonImport.types';
import styles from './McpFormModal.module.scss';

/**
 * Пакетное добавление MCP-серверов из JSON.
 *
 * Документация серверов почти всегда даёт готовый блок `mcpServers` — проще
 * вставить его целиком и получить сразу несколько серверов, чем переносить
 * каждый руками по полям. Понимаем и обёртку `{ mcpServers: {…} }`, и просто
 * объект серверов.
 */
export function McpJsonImport({ onDone }: McpJsonImportProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const create = mcpServerApi.useCreate();

  const parsed = useMemo(() => parseServers(text), [text]);

  const importAll = async (): Promise<void> => {
    setIsCreating(true);
    // По одному по порядку: конфиг MCP — общий файл, параллельная запись
    // затирала бы одни серверы другими.
    for (const draft of parsed.drafts) {
      await create.mutateAsync(draft);
    }
    setIsCreating(false);
    onDone();
  };

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {t('mcp.importLabel')}
        </Typography>
        <textarea
          className={styles.jsonInput}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={PLACEHOLDER}
          rows={12}
          spellCheck={false}
        />
        <Typography variant="caption" color="subtle">
          {t('mcp.importHint')}
        </Typography>
      </Stack>

      {text.trim() && parsed.error && (
        <Typography variant="body-sm" color="danger">
          {parsed.error}
        </Typography>
      )}

      {parsed.drafts.length > 0 && (
        <Stack gap="var(--spacing-2xs)">
          <Badge tone="success">
            {parsed.drafts.length} {t('mcp.importFound')}
          </Badge>

          <div className={styles.importPreview}>
            {parsed.drafts.map((draft) => (
              <Stack
                key={draft.name}
                direction="row"
                align="center"
                gap="var(--spacing-xs)"
                className={styles.importRow}
              >
                <Badge tone="neutral">{draft.transport}</Badge>
                <Typography variant="mono" weight="medium" as="span">
                  {draft.name}
                </Typography>
                <Typography variant="mono" color="subtle" as="span" truncate>
                  {draft.transport === 'stdio'
                    ? `${draft.command} ${draft.args.join(' ')}`
                    : draft.url}
                </Typography>
              </Stack>
            ))}
          </div>
        </Stack>
      )}

      <Button
        variant="primary"
        leftIcon={<Icon name="plus" size={18} />}
        onClick={importAll}
        disabled={parsed.drafts.length === 0 || isCreating}
        isLoading={isCreating}
      >
        {t('mcp.importAll', { count: parsed.drafts.length })}
      </Button>
    </Stack>
  );
}

interface RawServer {
  command?: string;
  args?: unknown[];
  url?: string;
  type?: string;
  transport?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * Разбор JSON в список черновиков. Транспорт определяется по наличию url:
 * это надёжнее поля type, которое в разных источниках называется по-разному.
 */
function parseServers(text: string): { drafts: McpServerDraft[]; error?: string } {
  if (!text.trim()) return { drafts: [] };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { drafts: [], error: 'JSON не разбирается — проверьте синтаксис' };
  }

  const root = json as { mcpServers?: Record<string, RawServer> } & Record<string, RawServer>;
  const servers = root.mcpServers ?? root;

  if (!servers || typeof servers !== 'object') {
    return { drafts: [], error: 'Не нашёл серверов: ожидается объект mcpServers' };
  }

  const drafts: McpServerDraft[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || name === 'mcpServers') continue;

    const hasUrl = typeof raw.url === 'string' && raw.url.length > 0;
    drafts.push({
      name,
      transport: hasUrl ? (raw.type === 'http' ? 'http' : 'sse') : 'stdio',
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      url: raw.url,
      env: raw.env ?? {},
      headers: raw.headers ?? {},
      groupIds: [],
    });
  }

  if (drafts.length === 0) return { drafts: [], error: 'В JSON нет ни одного сервера' };
  return { drafts };
}

const PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
    },
    "sentry": { "url": "https://mcp.sentry.dev/sse" }
  }
}`;
