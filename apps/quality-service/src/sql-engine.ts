import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import type { StatementSync } from "node:sqlite";

export type SqlEngineName = "node-sqlite" | "sqljs";

export type SqlStatement = {
  run: (...params: unknown[]) => { lastInsertRowid: number | bigint; changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type SqlEngine = {
  readonly name: SqlEngineName;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
};

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  };
};

function requireFromHere(id: string): unknown {
  const req = createRequire(import.meta.url);
  return req(id);
}

export function tryOpenNodeSqlite(dbPath: string): SqlEngine | undefined {
  try {
    const builtin = "node:" + "sqlite";
    const mod = requireFromHere(builtin) as NodeSqliteModule;
    if (!mod?.DatabaseSync) return undefined;
    const db = new mod.DatabaseSync(dbPath);
    return {
      name: "node-sqlite",
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
    };
  } catch {
    return undefined;
  }
}

export function openNodeSqliteSync(dbPath: string): SqlEngine {
  const engine = tryOpenNodeSqlite(dbPath);
  if (!engine) {
    const err = new Error("node:sqlite is not available in this process");
    (err as { code?: string }).code = "QUALITY_SQLITE_UNAVAILABLE";
    throw err;
  }
  return engine;
}

function resolveSqlWasm(): string {
  const fromEnv = process.env.PRAXIS_SQL_WASM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates: string[] = [];
  if (process.argv[1]) {
    candidates.push(join(dirname(resolve(process.argv[1])), "sql-wasm.wasm"));
  }
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "sql-wasm.wasm"));
  } catch {
    /* bundled CJS may still resolve argv[1] */
  }
  try {
    const pkg = requireFromHere("sql.js/package.json") as { name?: string };
    if (pkg) {
      const req = createRequire(import.meta.url);
      candidates.push(join(dirname(req.resolve("sql.js/package.json")), "dist", "sql-wasm.wasm"));
    }
  } catch {
    /* packaged MCPB does not ship sql.js as a separate package */
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const err = new Error("Quality SQLite wasm asset is missing from the packaged Runtime");
  (err as { code?: string }).code = "QUALITY_SQLITE_UNAVAILABLE";
  throw err;
}

let sqlJsInit: Promise<Awaited<ReturnType<typeof loadSqlJs>>> | undefined;

async function loadSqlJs() {
  const wasmPath = resolveSqlWasm();
  const wasmBinary = readFileSync(wasmPath);
  return initSqlJs({
    wasmBinary,
    locateFile: (file) => (file.endsWith(".wasm") ? wasmPath : file),
  });
}

function sqlJsNumeric(db: { exec: (sql: string) => Array<{ values: unknown[][] }> }, sql: string): number {
  const result = db.exec(sql);
  const value = result[0]?.values?.[0]?.[0];
  return Number(value ?? 0);
}

export async function openSqlJs(dbPath: string): Promise<SqlEngine> {
  if (!sqlJsInit) sqlJsInit = loadSqlJs();
  const SQL = await sqlJsInit;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const existing =
    dbPath !== ":memory:" && existsSync(dbPath) ? new Uint8Array(readFileSync(dbPath)) : undefined;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();

  const persist = (): void => {
    if (dbPath === ":memory:") return;
    writeFileSync(dbPath, Buffer.from(db.export()));
  };

  return {
    name: "sqljs",
    exec(sql) {
      db.run(sql);
      persist();
    },
    prepare(sql) {
      return {
        run(...params: unknown[]) {
          if (params.length) db.run(sql, params);
          else db.run(sql);
          persist();
          return {
            lastInsertRowid: sqlJsNumeric(db, "SELECT last_insert_rowid()"),
            changes: sqlJsNumeric(db, "SELECT changes()"),
          };
        },
        get(...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (params.length) stmt.bind(params);
          if (!stmt.step()) {
            stmt.free();
            return undefined;
          }
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (params.length) stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
      };
    },
    close() {
      persist();
      db.close();
    },
  };
}

export async function openSqliteEngine(dbPath: string): Promise<SqlEngine> {
  const prefer = process.env.PRAXIS_QUALITY_SQLITE;
  if (prefer !== "sqljs") {
    const nodeEngine = tryOpenNodeSqlite(dbPath);
    if (nodeEngine) return nodeEngine;
    if (prefer === "node") {
      const err = new Error("node:sqlite was required but is not available");
      (err as { code?: string }).code = "QUALITY_SQLITE_UNAVAILABLE";
      throw err;
    }
  }
  return openSqlJs(dbPath);
}
