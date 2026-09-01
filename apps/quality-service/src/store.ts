import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ReviewRow = {
  id: number;
  mr_ref: string;
  project_id: string;
  result: string;
  notes: string;
  created_at: string;
  merged_at: string;
};

export type AuditRow = {
  id: number;
  path: string;
  project_id: string;
  findings: string;
  created_at: string;
};

export type Metrics = {
  reviews: number;
  audits: number;
  rollbacks: number;
  returns: number;
  /** Share of merged MRs that had a rollback/hotfix within `windowDays` after merge (default 7). */
  rollbackRate: number;
  /** Share of distinct tasks that were returned (returns / tasksObserved). */
  returnRate: number;
  windowDays: number;
  rollbacksWithinWindow: number;
  tasksObserved: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export class QualityStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mr_ref TEXT NOT NULL,
        project_id TEXT NOT NULL,
        result TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        merged_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        project_id TEXT NOT NULL,
        findings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rollback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        mr_ref TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS return_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_ref TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_ref TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
    `);
    // Best-effort column add for DBs created before merged_at existed.
    try {
      this.db.exec(`ALTER TABLE reviews ADD COLUMN merged_at TEXT`);
      this.db.exec(`UPDATE reviews SET merged_at = created_at WHERE merged_at IS NULL`);
    } catch {
      /* column already exists */
    }
  }

  now(): string {
    return new Date().toISOString();
  }

  addReview(input: {
    mrRef: string;
    projectId: string;
    result: string;
    notes?: string;
    mergedAt?: string;
  }): ReviewRow {
    const created_at = this.now();
    const merged_at = input.mergedAt ?? created_at;
    const info = this.db
      .prepare(
        `INSERT INTO reviews (mr_ref, project_id, result, notes, created_at, merged_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.mrRef,
        input.projectId,
        input.result,
        input.notes ?? "",
        created_at,
        merged_at,
      );
    return {
      id: Number(info.lastInsertRowid),
      mr_ref: input.mrRef,
      project_id: input.projectId,
      result: input.result,
      notes: input.notes ?? "",
      created_at,
      merged_at,
    };
  }

  addAudit(input: {
    path: string;
    projectId: string;
    findings: string;
  }): AuditRow {
    const created_at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO audits (path, project_id, findings, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.path, input.projectId, input.findings, created_at);
    return {
      id: Number(info.lastInsertRowid),
      path: input.path,
      project_id: input.projectId,
      findings: input.findings,
      created_at,
    };
  }

  addRollback(input: {
    projectId: string;
    mrRef: string;
    reason?: string;
    createdAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rollback_events (project_id, mr_ref, reason, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.mrRef,
        input.reason ?? "",
        input.createdAt ?? this.now(),
      );
  }

  addReturn(input: {
    projectId: string;
    taskRef: string;
    source: string;
    createdAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO return_events (project_id, task_ref, source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.taskRef,
        input.source,
        input.createdAt ?? this.now(),
      );
  }

  /** Record a completed task so returnRate has a proper denominator. */
  addTaskCompletion(input: {
    projectId: string;
    taskRef: string;
    completedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_completions (project_id, task_ref, completed_at)
         VALUES (?, ?, ?)`,
      )
      .run(input.projectId, input.taskRef, input.completedAt ?? this.now());
  }

  report(projectId: string): {
    reviews: ReviewRow[];
    audits: AuditRow[];
  } {
    const reviews = this.db
      .prepare(`SELECT * FROM reviews WHERE project_id = ? ORDER BY id`)
      .all(projectId) as ReviewRow[];
    const audits = this.db
      .prepare(`SELECT * FROM audits WHERE project_id = ? ORDER BY id`)
      .all(projectId) as AuditRow[];
    return { reviews, audits };
  }

  metrics(projectId?: string, opts?: { windowDays?: number }): Metrics {
    const windowDays = opts?.windowDays ?? 7;
    const where = projectId ? " WHERE project_id = ?" : "";
    const args = projectId ? [projectId] : [];
    const count = (table: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${table}${where}`)
        .get(...args) as { c: number };
      return Number(row.c);
    };

    const reviews = this.db
      .prepare(`SELECT * FROM reviews${where}`)
      .all(...args) as ReviewRow[];
    const rollbacks = this.db
      .prepare(`SELECT * FROM rollback_events${where}`)
      .all(...args) as {
      mr_ref: string;
      created_at: string;
    }[];
    const returns = count("return_events");
    const audits = count("audits");

    const rollbacksByMr = new Map<string, string[]>();
    for (const rb of rollbacks) {
      const list = rollbacksByMr.get(rb.mr_ref) ?? [];
      list.push(rb.created_at);
      rollbacksByMr.set(rb.mr_ref, list);
    }

    let rollbacksWithinWindow = 0;
    for (const rev of reviews) {
      const mergeMs = Date.parse(rev.merged_at || rev.created_at);
      if (Number.isNaN(mergeMs)) continue;
      const times = rollbacksByMr.get(rev.mr_ref) ?? [];
      const hit = times.some((t) => {
        const rbMs = Date.parse(t);
        if (Number.isNaN(rbMs)) return false;
        const delta = rbMs - mergeMs;
        return delta >= 0 && delta <= windowDays * DAY_MS;
      });
      if (hit) rollbacksWithinWindow += 1;
    }

    const rollbackRate =
      reviews.length === 0 ? 0 : rollbacksWithinWindow / reviews.length;

    const completedTasks = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task_ref) AS c FROM task_completions${where}`,
      )
      .get(...args) as { c: number };
    const returnedTasks = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task_ref) AS c FROM return_events${where}`,
      )
      .get(...args) as { c: number };
    const tasksObserved = Math.max(
      Number(completedTasks.c),
      Number(returnedTasks.c),
    );
    const returnRate =
      tasksObserved === 0 ? 0 : Number(returnedTasks.c) / tasksObserved;

    return {
      reviews: reviews.length,
      audits,
      rollbacks: rollbacks.length,
      returns,
      rollbackRate,
      returnRate,
      windowDays,
      rollbacksWithinWindow,
      tasksObserved,
    };
  }

  close(): void {
    this.db.close();
  }

  getReview(id: number): ReviewRow | null {
    const row = this.db
      .prepare(`SELECT * FROM reviews WHERE id = ?`)
      .get(id) as ReviewRow | undefined;
    return row ?? null;
  }
}
