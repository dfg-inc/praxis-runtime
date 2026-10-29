#!/usr/bin/env node
/**
 * Writes example HTML reviews (requirements, prototype, story plan, stories) for a small sample project, using the same
 * renderers the Runtime serves. Usage: node tools/scripts/ux-overhaul-examples.mjs <output-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyWorkflowCommand, renderReview } from "@praxis/contracts";

const out = resolve(process.argv[2] ?? "examples");
mkdirSync(out, { recursive: true });
const now = new Date("2026-10-26T12:00:00.000Z");
let state = null;
const user = { via: "html-review" };
const run = (command, channel) => {
  state = applyWorkflowCommand(state, command, { now, ...(channel ? { channel } : {}) }).state;
};
run({ action: "open", projectId: "orders", title: "Order list for managers", request: "Managers need to see, search, edit and export orders", mode: "guided" });
run({ action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view, search and edit orders; other roles can only view", acceptanceCriteria: ["The list shows all orders with number, customer and status", "A manager can search orders by number or customer", "A manager can change an order's status", "A viewer sees orders but cannot change them"] });
run({ action: "add-requirement", id: "REQ-ORD-002", statement: "Managers can export the filtered orders to CSV", acceptanceCriteria: ["The export contains exactly the filtered rows", "The export has a header row"] });
run({ action: "add-requirement", id: "REQ-ORD-003", statement: "Order history is kept for audit (<b>next release</b>)", acceptanceCriteria: ["Every status change is stored with who and when"] });
run({ action: "set-requirement-scope", requirementIds: ["REQ-ORD-003"], scope: "deferred", note: "audit trail is planned for the next release" });
const requirementsHtml = renderReview(state, "requirements", { generatedAt: now.toISOString() });
run({ action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }, { id: "REQ-ORD-001-AC-02", status: "rejected", comment: "also by phone number" }] }] }, user);
const requirementsPartial = renderReview(state, "requirements", { generatedAt: now.toISOString() });
run({ action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-02", statement: "A manager can search orders by number, customer or phone number" }] }] });
run({ action: "accept-requirements" }, user);
run({
  action: "set-prototype",
  summary: "first version",
  prototype: {
    kind: "ui",
    title: "Orders",
    notes: "Mock data only. Styles read from the application's own css.",
    startScreen: "list",
    roles: ["manager", "viewer"],
    styles: { colors: { primary: "#0b6bcb", background: "#ffffff", text: "#1b1f24" }, fonts: { body: "Inter, system-ui, sans-serif" }, radius: "8px", sources: [{ file: "src/styles/theme.css" }] },
    mock: [{ id: "orders", name: "Orders", fields: [{ key: "number", label: "Number", type: "string" }, { key: "customer", label: "Customer", type: "string" }, { key: "status", label: "Status", type: "string" }], rows: [{ number: "A-1001", customer: "Acme", status: "new" }, { number: "A-1002", customer: "Globex", status: "paid" }, { number: "A-1003", customer: "Initech", status: "shipped" }] }],
    screens: [
      { id: "list", title: "Orders", description: "All orders, with search.", states: ["default", "loading", "empty", "error", "denied"], stateMessages: { error: "Cannot load orders. Try again.", empty: "No orders match your search." }, elements: [
        { id: "search", kind: "search", label: "Search by number or customer", collection: "orders", intent: "search", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-02"] },
        { id: "tbl", kind: "table", label: "Orders", collection: "orders", columns: ["number", "customer", "status"], intent: "view", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01"] },
        { id: "add", kind: "button", label: "Add test order", action: "add-row", collection: "orders", allowedRoles: ["manager"], requirementIds: [], acIds: [] },
        { id: "open", kind: "button", label: "Open order", navigatesTo: "detail", requirementIds: [], acIds: [] },
      ] },
      { id: "detail", title: "Order details", states: ["default", "success", "error"], elements: [
        { id: "h", kind: "heading", label: "Order A-1001" },
        { id: "status", kind: "field", label: "Status", collection: "orders", field: "status", intent: "edit", allowedRoles: ["manager"], requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-03", "REQ-ORD-001-AC-04"] },
        { id: "export", kind: "button", label: "Export CSV", action: "submit", requirementIds: ["REQ-ORD-002"], acIds: ["REQ-ORD-002-AC-01"] },
        { id: "back", kind: "link", label: "Back to the list", navigatesTo: "list" },
      ] },
    ],
    endpoints: [],
  },
});
run({ action: "prototype-feedback", items: [{ target: "list#tbl", comment: "Show the order total as well" }] }, user);
const prototypeHtml = renderReview(state, "prototype", { generatedAt: now.toISOString() });
run({ action: "accept-prototype" }, user);
run({ action: "advance-phase", to: "requirements_review" });
run({ action: "advance-phase", to: "prototype" });
run({ action: "advance-phase", to: "story_plan" });
run({ action: "set-story-plan", entries: [
  { id: "US-ORD-001", title: "See and search orders", implementation: "Order list page with a search box", userGets: "All orders, found by number or customer", data: ["orders"], screenRefs: ["list"], requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01", "REQ-ORD-001-AC-02"], repositoryIds: [], capabilities: ["view", "search", "states", "error"] },
  { id: "US-ORD-002", title: "Change an order's status", implementation: "Status field on the details page; viewers see it read-only", userGets: "Managers update a status; viewers cannot", data: ["orders.status"], screenRefs: ["detail#status"], requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-03", "REQ-ORD-001-AC-04"], capabilities: ["edit", "permissions"], dependsOn: ["US-ORD-001"] },
  { id: "US-ORD-003", title: "Export filtered orders", implementation: "Export button producing a CSV of the current filter", userGets: "A CSV with a header row and exactly the filtered rows", data: ["orders"], screenRefs: ["detail#export"], requirementIds: ["REQ-ORD-002"], acIds: ["REQ-ORD-002-AC-01", "REQ-ORD-002-AC-02"], capabilities: ["filter", "states"], dependsOn: ["US-ORD-001"] },
] });
const planHtml = renderReview(state, "story-plan", { generatedAt: now.toISOString() });
run({ action: "agree-story-plan" }, user);
const story = (id, title, requirementIds, narrative, steps, criteria, extra = {}) => ({ action: "add-story", id, title, requirementIds, actor: "manager", narrative, objective: title, userValue: "Work with orders without leaving the list", preconditions: ["The manager is signed in"], happyPath: steps, alternatives: ["Nothing matches: an empty state is shown"], negative: ["A viewer opens the page: controls are read-only"], edgeCases: ["More than 1000 orders: the list is paged"], businessRules: ["Order numbers are unique"], acceptanceCriteria: criteria, expectedResults: ["The result is visible without a reload"], confirmedBehavior: false, ...extra });
run(story("US-ORD-001", "See and search orders", ["REQ-ORD-001"], "As a manager, I want to see and search orders, so that I can find the one I need.", ["Open the orders page", "Type a number or customer", "See the matching orders"], [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "the manager opens the page", then: "all orders are listed with number, customer and status" }, { id: "US-ORD-001-AC-02", given: "orders exist", when: "the manager searches for a number", then: "only matching orders are listed" }]));
run(story("US-ORD-002", "Change an order's status", ["REQ-ORD-001"], "As a manager, I want to change an order's status, so that it reflects reality.", ["Open an order", "Choose a new status", "Save"], [{ id: "US-ORD-002-AC-01", given: "an order is open", when: "the manager saves a new status", then: "the status is updated" }]));
run(story("US-ORD-003", "Export filtered orders", ["REQ-ORD-002"], "As a manager, I want to export the filtered orders, so that I can share them.", ["Filter the list", "Press Export", "Receive a CSV"], [{ id: "US-ORD-003-AC-01", given: "a filter is applied", when: "the manager exports", then: "the CSV contains exactly the filtered rows with a header" }]));
run({ action: "review-stories", items: [{ storyId: "US-ORD-001", revision: 1, key: "step:0", status: "accepted" }, { storyId: "US-ORD-001", revision: 1, key: "step:1", status: "accepted" }, { storyId: "US-ORD-001", revision: 1, key: "ac:US-ORD-001-AC-02", status: "rejected", comment: "also match the customer's e-mail" }], acceptStories: [] }, user);
const storiesHtml = renderReview(state, "stories", { generatedAt: now.toISOString() });
for (const [name, html] of [["1-requirements-review-fresh.html", requirementsHtml], ["2-requirements-review-in-progress.html", requirementsPartial], ["3-prototype-review.html", prototypeHtml], ["4-story-plan-review.html", planHtml], ["5-stories-review.html", storiesHtml]]) writeFileSync(resolve(out, name), html);
console.log(`wrote 5 pages to ${out}`);
