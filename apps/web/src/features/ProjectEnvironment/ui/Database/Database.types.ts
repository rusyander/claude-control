import type { DbConnection, DbConnectionsInfo, DbSchema, DbUnsupported } from '@entities/Database';

export interface DatabasePanelProps {
  projectPath: string;
  isOpen: boolean;
  /** Перейти на вкладку «Сервисы» — база в Compose не поднята. */
  onShowServices: () => void;
}

export interface DbConnectionBarProps {
  connections: DbConnection[];
  selected: DbConnection | undefined;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (connection: DbConnection) => void;
  onRemove: (connection: DbConnection) => void;
}

export interface DbConnectionFormProps {
  projectPath: string;
  /** Правка своего подключения; не задано — новое. */
  editing?: DbConnection;
  onDone: (savedId?: string) => void;
}

export interface DbSchemaTreeProps {
  projectPath: string;
  connectionId: string;
  onInsert: (sql: string) => void;
}

export interface DbSchemaListProps {
  schema: DbSchema;
  filter: string;
  onInsert: (sql: string) => void;
}

export interface DbQueryEditorProps {
  projectPath: string;
  connectionId: string;
  sql: string;
  onSqlChange: (sql: string) => void;
}

export interface DbMigrationsProps {
  projectPath: string;
  connectionId: string | undefined;
}

export interface DbAgentAccessProps {
  projectPath: string;
  info: DbConnectionsInfo;
}

export interface DbUnsupportedListProps {
  items: DbUnsupported[];
}
