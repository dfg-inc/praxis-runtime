import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  openNodeSqliteSync,
  openSqliteEngine,
  type SqlEngine,
  type SqlEngineName,
} from "./sql-engine.js";

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
  kind?: string | null;
  verdict?: string | null;
  scope?: string | null;
  report_json?: string | null;
  report_md?: string | null;
};

export type RollbackRow = {
  id: number;
  project_id: string;
  mr_ref: string;
  reason: string;
  created_at: string;
  work_package_id?: string | null;
  affected_ref?: string | null;
  trigger_source?: string | null;
  review_id?: number | null;
  status?: string | null;
  evidence?: string | null;
  payload?: string | null;
};

export type HotfixRow = {
  id: number;
  project_id: string;
  rollback_id: number | null;
  incident_ref: string | null;
  hotfix_ref: string;
  reason: string;
  work_package_id: string | null;
  review_id: number | null;
  verification: string | null;
  created_at: string;
  payload: string;
};

export type ReturnRow = {
  id: number;
  project_id: string;
  task_ref: string;
  source: string;
  created_at: string;
  review_id?: number | null;
  finding_ids?: string | null;
  reason?: string | null;
  status?: string | null;
  resolved_at?: string | null;
  followup_review_id?: number | null;
  payload?: string | null;
};

export type NormProposalRow = {
  id: number;
  project_id: string;
  fingerprint: string;
  occurrence_count: number;
  source_ids: string;
  knowledge_rule_id: string | null;
  status: string;
  created_at: string;
};

export type Metrics = {
  reviews: number;
  audits: number;
  rollbacks: number;
  returns: number;
  hotfixes: number;
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
  private readonly db: SqlEngine;
  readonly engineName: SqlEngineName;

  constructor(dbPath: string, engine?: SqlEngine) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = engine ?? openNodeSqliteSync(dbPath);
    this.engineName = this.db.name;
    this.migrate();
  }

  static async create(dbPath: string): Promise<QualityStore> {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const engine = await openSqliteEngine(dbPath);
    return new QualityStore(dbPath, engine);
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
    const alters = [
      `ALTER TABLE audits ADD COLUMN kind TEXT`,
      `ALTER TABLE audits ADD COLUMN verdict TEXT`,
      `ALTER TABLE audits ADD COLUMN scope TEXT`,
      `ALTER TABLE audits ADD COLUMN report_json TEXT`,
      `ALTER TABLE audits ADD COLUMN report_md TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN work_package_id TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN affected_ref TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN trigger_source TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN review_id INTEGER`,
      `ALTER TABLE rollback_events ADD COLUMN status TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN evidence TEXT`,
      `ALTER TABLE rollback_events ADD COLUMN payload TEXT`,
      `ALTER TABLE return_events ADD COLUMN review_id INTEGER`,
      `ALTER TABLE return_events ADD COLUMN finding_ids TEXT`,
      `ALTER TABLE return_events ADD COLUMN reason TEXT`,
      `ALTER TABLE return_events ADD COLUMN status TEXT`,
      `ALTER TABLE return_events ADD COLUMN resolved_at TEXT`,
      `ALTER TABLE return_events ADD COLUMN followup_review_id INTEGER`,
      `ALTER TABLE return_events ADD COLUMN payload TEXT`,
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch {
        /* already exists */
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hotfix_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        rollback_id INTEGER,
        incident_ref TEXT,
        hotfix_ref TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        work_package_id TEXT,
        review_id INTEGER,
        verification TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS norm_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        source_ids TEXT NOT NULL,
        knowledge_rule_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, fingerprint)
      );
    `);
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
    kind?: string;
    verdict?: string;
    scope?: string;
    reportJson?: string;
    reportMd?: string;
  }): AuditRow {
    const created_at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO audits (path, project_id, findings, created_at, kind, verdict, scope, report_json, report_md)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.path,
        input.projectId,
        input.findings,
        created_at,
        input.kind ?? "path-review",
        input.verdict ?? null,
        input.scope ?? null,
        input.reportJson ?? null,
        input.reportMd ?? null,
      );
    return this.getAudit(Number(info.lastInsertRowid))!;
  }

  addRollback(input: {
    projectId: string;
    mrRef: string;
    reason?: string;
    createdAt?: string;
    workPackageId?: string;
    affectedRef?: string;
    trigger?: string;
    reviewId?: number;
    status?: string;
    evidence?: string;
    payload?: string;
  }): RollbackRow {
    const created_at = input.createdAt ?? this.now();
    const info = this.db
      .prepare(
        `INSERT INTO rollback_events (
           project_id, mr_ref, reason, created_at, work_package_id, affected_ref,
           trigger_source, review_id, status, evidence, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.mrRef,
        input.reason ?? "",
        created_at,
        input.workPackageId ?? null,
        input.affectedRef ?? null,
        input.trigger ?? null,
        input.reviewId ?? null,
        input.status ?? "recorded",
        input.evidence ?? null,
        input.payload ?? null,
      );
    return this.getRollback(Number(info.lastInsertRowid))!;
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

    let hotfixes = 0;
    try {
      hotfixes = count("hotfix_events");
    } catch {
      hotfixes = 0;
    }

    return {
      reviews: reviews.length,
      audits,
      rollbacks: rollbacks.length,
      returns,
      hotfixes,
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

  listReviews(projectId?: string): ReviewRow[] {
    if (projectId) {
      return this.db
        .prepare(`SELECT * FROM reviews WHERE project_id = ? ORDER BY id`)
        .all(projectId) as ReviewRow[];
    }
    return this.db.prepare(`SELECT * FROM reviews ORDER BY id`).all() as ReviewRow[];
  }

  updateReviewNotes(id: number, notes: string): void {
    this.db.prepare(`UPDATE reviews SET notes = ? WHERE id = ?`).run(notes, id);
  }

  getAudit(id: number): AuditRow | null {
    const row = this.db
      .prepare(`SELECT * FROM audits WHERE id = ?`)
      .get(id) as AuditRow | undefined;
    return row ?? null;
  }

  writeAuditReport(id: number, reportJson: string, reportMd: string): void {
    this.db
      .prepare(`UPDATE audits SET report_json = ?, report_md = ? WHERE id = ?`)
      .run(reportJson, reportMd, id);
  }

  listCodebaseAudits(projectId: string): AuditRow[] {
    return this.db
      .prepare(
        `SELECT * FROM audits WHERE project_id = ? AND kind = 'codebase' ORDER BY id`,
      )
      .all(projectId) as AuditRow[];
  }

  getRollback(id: number): RollbackRow | null {
    const row = this.db
      .prepare(`SELECT * FROM rollback_events WHERE id = ?`)
      .get(id) as RollbackRow | undefined;
    return row ?? null;
  }

  listRollbacks(projectId: string): RollbackRow[] {
    return this.db
      .prepare(`SELECT * FROM rollback_events WHERE project_id = ? ORDER BY id`)
      .all(projectId) as RollbackRow[];
  }

  addHotfix(input: {
    projectId: string;
    rollbackId: number;
    hotfixRef: string;
    reason: string;
    workPackageId?: string;
    reviewId?: number;
    verification?: string;
    payload?: string;
  }): HotfixRow {
    const created_at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO hotfix_events (
           project_id, rollback_id, incident_ref, hotfix_ref, reason,
           work_package_id, review_id, verification, created_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.rollbackId,
        `rollback:${input.rollbackId}`,
        input.hotfixRef,
        input.reason,
        input.workPackageId ?? null,
        input.reviewId ?? null,
        input.verification ?? null,
        created_at,
        input.payload ?? "{}",
      );
    return this.getHotfix(Number(info.lastInsertRowid))!;
  }

  getHotfix(id: number): HotfixRow | null {
    const row = this.db
      .prepare(`SELECT * FROM hotfix_events WHERE id = ?`)
      .get(id) as HotfixRow | undefined;
    return row ?? null;
  }

  listHotfixes(projectId: string): HotfixRow[] {
    return this.db
      .prepare(`SELECT * FROM hotfix_events WHERE project_id = ? ORDER BY id`)
      .all(projectId) as HotfixRow[];
  }

  addReturnEvent(input: {
    projectId: string;
    taskRef: string;
    source: string;
    reviewId: number;
    findingIds: string[];
    reason: string;
    payload?: string;
  }): ReturnRow {
    const created_at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO return_events (
           project_id, task_ref, source, created_at, review_id, finding_ids,
           reason, status, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.taskRef,
        input.source,
        created_at,
        input.reviewId,
        JSON.stringify(input.findingIds),
        input.reason,
        "open",
        input.payload ?? null,
      );
    return this.getReturn(Number(info.lastInsertRowid))!;
  }

  getReturn(id: number): ReturnRow | null {
    const row = this.db
      .prepare(`SELECT * FROM return_events WHERE id = ?`)
      .get(id) as ReturnRow | undefined;
    return row ?? null;
  }

  listReturns(projectId: string): ReturnRow[] {
    return this.db
      .prepare(`SELECT * FROM return_events WHERE project_id = ? ORDER BY id`)
      .all(projectId) as ReturnRow[];
  }

  resolveReturn(id: number, followUpReviewId: number): ReturnRow {
    this.db
      .prepare(
        `UPDATE return_events SET status = ?, resolved_at = ?, followup_review_id = ? WHERE id = ?`,
      )
      .run("resolved", this.now(), followUpReviewId, id);
    return this.getReturn(id)!;
  }

  getNormProposal(projectId: string, fingerprint: string): NormProposalRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM norm_proposals WHERE project_id = ? AND fingerprint = ?`,
      )
      .get(projectId, fingerprint) as NormProposalRow | undefined;
    return row ?? null;
  }

  addNormProposal(input: {
    projectId: string;
    fingerprint: string;
    occurrenceCount: number;
    sourceIds: string[];
    knowledgeRuleId?: string;
    status: string;
  }): NormProposalRow {
    const created_at = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO norm_proposals (
           project_id, fingerprint, occurrence_count, source_ids,
           knowledge_rule_id, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.fingerprint,
        input.occurrenceCount,
        JSON.stringify(input.sourceIds),
        input.knowledgeRuleId ?? null,
        input.status,
        created_at,
      );
    return this.db
      .prepare(`SELECT * FROM norm_proposals WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as NormProposalRow;
  }

  listNormProposals(projectId: string): NormProposalRow[] {
    return this.db
      .prepare(`SELECT * FROM norm_proposals WHERE project_id = ? ORDER BY id`)
      .all(projectId) as NormProposalRow[];
  }
}
