import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads a work item's persisted state straight from disk (index layout), not through the store. */
export function readPersistedState<T = Record<string, unknown>>(repo: string, workItemId?: string): T {
  const dir = join(repo, ".praxis", "workflow");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { current: string | null };
  const id = workItemId ?? index.current;
  if (!id) throw new Error("no current work item");
  return JSON.parse(readFileSync(join(dir, "items", `${id}.json`), "utf8")) as T;
}

export type McpEnvelope = {
  ok: boolean;
  code?: string;
  errors?: string[];
  warnings: string[];
  data: Record<string, any>;
};
