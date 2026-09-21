declare module "sql.js" {
  type SqlJsStatement = {
    bind: (params?: unknown[] | Record<string, unknown>) => boolean;
    step: () => boolean;
    getAsObject: () => Record<string, unknown>;
    free: () => void;
  };

  type SqlJsDatabase = {
    run: (sql: string, params?: unknown[]) => void;
    exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
    prepare: (sql: string) => SqlJsStatement;
    export: () => Uint8Array;
    close: () => void;
  };

  type SqlJsStatic = {
    Database: new (data?: ArrayBuffer | Uint8Array | null) => SqlJsDatabase;
  };

  type InitSqlJsConfig = {
    wasmBinary?: ArrayBuffer | Uint8Array;
    locateFile?: (file: string, prefix: string) => string;
  };

  const initSqlJs: (config?: InitSqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
