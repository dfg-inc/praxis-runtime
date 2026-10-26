import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Creates the BA canon root of a new project for hosts that cannot run the BA CLI (Claude Desktop Chat): the same files
 * `praxis-ba init` creates, byte for byte (see fixtures/canon-init and canon-init.test.ts). Only ever creates; an existing file or
 * folder is skipped, never overwritten or repaired; a symlink or a path of the wrong kind refuses the whole plan before the first
 * write. It does not create a first epic or the project documentation layer: `praxis-ba epic add` and the ba-scaffold skill do.
 */
export const CANON_FOLDERS = ["epics", "br", "cr", "wp", "bugs", "baselines"] as const;

const CONFIG = `canon_roots:\n  - vision.md\n  - epics/\n  - br/\n  - cr/\n  - wp/\n  - bugs/\n  - goals/\n`;
const COUNTERS = `product:\n  epic: 0\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics: {}\nretired: []\n`;
const VISION_BODY = `<!-- Draft vision. Replace this body with the product vision. Leave \`status: draft\`
in the frontmatter: only a human running \`praxis-ba vision confirm\` may set
\`status: confirmed\`. No work package can become ready while the vision is a draft. -->

State, in one or two paragraphs, what this product is for and the outcome
it exists to produce - the single sentence a stranger could use to judge
whether any future requirement belongs in scope. Plain prose; only the
frontmatter status is machine-checked.
`;

export function visionText(product?: string): string {
  const heading = product ? `# ${product.replace(/\s+/g, " ").trim()}\n\n` : "";
  return `---\ntype: vision\nstatus: draft\n---\n\n${heading}${VISION_BODY}`;
}
export const configText = (): string => CONFIG;
export const countersText = (): string => COUNTERS;

export type CanonInitPlan = { repo: string; create: Array<{ path: string; kind: "dir" | "file"; content?: string }>; skipped: string[]; next: string[] };

type Kind = "missing" | "file" | "dir";
function kindOf(abs: string, rel: string): Kind {
  let st;
  try {
    st = lstatSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error(`INVALID_INPUT: ${rel} is a symbolic link; refusing to write through it`);
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  throw new Error(`INVALID_INPUT: ${rel} exists but is neither a regular file nor a directory`);
}

export function planCanonInit(repoInput: string, options: { product?: string } = {}): CanonInitPlan {
  if (options.product !== undefined && !options.product.trim()) throw new Error("INVALID_INPUT: product must not be empty");
  if (!existsSync(repoInput)) throw new Error(`INVALID_INPUT: ${repoInput} does not exist`);
  const repo = realpathSync(resolve(repoInput));
  if (!lstatSync(repo).isDirectory()) throw new Error(`INVALID_INPUT: ${repo} is not a directory`);
  const create: CanonInitPlan["create"] = [];
  const skipped: string[] = [];
  const dir = (rel: string, mustBeDir = true) => {
    const k = kindOf(join(repo, rel), rel);
    if (k === "file" && mustBeDir) throw new Error(`INVALID_INPUT: ${rel} exists but is a file, expected a directory`);
    if (k === "dir") skipped.push(`${rel}/`);
    else create.push({ path: `${rel}/`, kind: "dir" });
    return k;
  };
  const file = (rel: string, content: string) => {
    const k = kindOf(join(repo, rel), rel);
    if (k === "dir") throw new Error(`INVALID_INPUT: ${rel} exists but is a directory, expected a file`);
    if (k === "file") skipped.push(rel);
    else create.push({ path: rel, kind: "file", content });
  };
  dir(".ba");
  file(".ba/config.yaml", CONFIG);
  file(".ba/counters.yaml", COUNTERS);
  file("vision.md", visionText(options.product?.trim()));
  for (const folder of CANON_FOLDERS) {
    const k = dir(folder);
    if (k === "missing") create.push({ path: `${folder}/.gitkeep`, kind: "file", content: "" });
  }
  return {
    repo,
    create,
    skipped,
    next: ["Optional: the ba-scaffold skill lays out the project documentation layer.", "Draft the vision in vision.md, then run the confirm-vision skill.", "Add the first epic with `praxis-ba epic add` (Claude Code or Cowork), then start with capture-cr."],
  };
}

export function applyCanonInit(plan: CanonInitPlan): string[] {
  const written: string[] = [];
  for (const item of plan.create) {
    const abs = join(plan.repo, item.path);
    if (item.kind === "dir") mkdirSync(abs, { recursive: false });
    else writeFileSync(abs, item.content ?? "", { encoding: "utf8", flag: "wx" });
    written.push(item.path);
  }
  return written;
}
