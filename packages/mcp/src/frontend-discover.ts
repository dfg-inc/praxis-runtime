import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isAgentInstructionFile } from "@praxis/contracts";

/**
 * Read-only look at an application's frontend: which framework, where the styles and components are, and the design
 * tokens (colors, fonts, radius) a prototype should reuse. Reads the repository, never writes, runs nothing, and returns
 * only values it parsed itself: file contents are never passed back as text, so instructions inside a repository cannot
 * travel through this tool.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "out", "coverage", ".turbo", ".cache", "vendor", "Pods", "DerivedData", ".gradle", "target", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 5000;
const MAX_DEPTH = 7;
const MAX_FILE_BYTES = 200_000;

const FRAMEWORKS: Array<[string, RegExp]> = [
  ["react", /^react$/],
  ["next", /^next$/],
  ["vue", /^vue$/],
  ["nuxt", /^nuxt/],
  ["angular", /^@angular\/core$/],
  ["svelte", /^svelte$/],
  ["solid", /^solid-js$/],
  ["tailwind", /^tailwindcss$/],
  ["mui", /^@mui\/material$/],
  ["antd", /^antd$/],
  ["chakra", /^@chakra-ui\//],
  ["bootstrap", /^bootstrap$/],
  ["styled-components", /^styled-components$/],
  ["emotion", /^@emotion\//],
  ["react-native", /^react-native$/],
  ["expo", /^expo$/],
];

const SAFE_VALUE = /^[#\w(),.%\s/'"-]{1,80}$/;

export type FrontendDiscovery = {
  root: string;
  isFrontend: boolean;
  kind: "web" | "mobile" | "none";
  frameworks: string[];
  styleFiles: string[];
  componentDirs: string[];
  screenCandidates: string[];
  styles: { colors: Record<string, string>; fonts: Record<string, string>; radius?: string; spacing?: string; sources: Array<{ file: string; note?: string }> };
  hasStyles: boolean;
  instructionFiles: string[];
  scannedFiles: number;
  truncated: boolean;
  note: string;
};

type Walked = { rel: string; abs: string; dir: boolean };

function walk(root: string): { files: Walked[]; truncated: boolean } {
  const out: Walked[] = [];
  let truncated = false;
  const visit = (dir: string, depth: number) => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join(dir, name);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name) || depth >= MAX_DEPTH) continue;
        out.push({ rel, abs, dir: true });
        visit(abs, depth + 1);
      } else if (stat.isFile()) {
        out.push({ rel, abs, dir: false });
      }
    }
  };
  visit(root, 0);
  return { files: out, truncated };
}

function readSmall(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function colorName(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/(^|-)primary(-|$)|brand/.test(n)) return "primary";
  if (/secondary|accent/.test(n)) return "secondary";
  if (/danger|error|destructive|negative/.test(n)) return "danger";
  if (/success|positive/.test(n)) return "success";
  if (/warn/.test(n)) return "warning";
  if (/(^|-)(background|bg|surface)(-|$)/.test(n)) return "background";
  if (/(^|-)(foreground|text|fg|ink)(-|$)/.test(n)) return "text";
  if (/border|divider|line/.test(n)) return "border";
  return undefined;
}

function tokensFromCss(text: string, file: string, tokens: FrontendDiscovery["styles"]): boolean {
  let found = false;
  for (const match of text.matchAll(/--([\w-]+)\s*:\s*([^;}\n]+)[;}\n]/g)) {
    const name = match[1];
    const value = match[2].trim();
    if (!SAFE_VALUE.test(value)) continue;
    const color = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/.test(value) ? colorName(name) : undefined;
    if (color && !(color in tokens.colors)) {
      tokens.colors[color] = value;
      found = true;
    } else if (/font/.test(name) && !tokens.fonts.body && /sans|serif|mono|system|inter|roboto|helvetica|arial|font/i.test(value)) {
      tokens.fonts.body = value;
      found = true;
    } else if (/radius/.test(name) && !tokens.radius) {
      tokens.radius = value;
      found = true;
    } else if (/(^|-)(spacing|space|gap)(-|$)/.test(name) && !tokens.spacing) {
      tokens.spacing = value;
      found = true;
    }
  }
  const family = text.match(/font-family\s*:\s*([^;}\n]+)[;}\n]/);
  if (family && !tokens.fonts.body && SAFE_VALUE.test(family[1].trim())) {
    tokens.fonts.body = family[1].trim();
    found = true;
  }
  if (found) tokens.sources.push({ file });
  return found;
}

function tokensFromScript(text: string, file: string, tokens: FrontendDiscovery["styles"]): boolean {
  let found = false;
  // tailwind / theme objects: primary: '#123456', "primary": "#123456", primary: { main: '#123456' } (mui)
  for (const match of text.matchAll(/["']?([A-Za-z][\w-]*)["']?\s*:\s*(?:\{\s*(?:main|DEFAULT|500)\s*:\s*)?["'](#[0-9a-fA-F]{3,8})["']/g)) {
    const color = colorName(match[1]);
    if (color && !(color in tokens.colors)) {
      tokens.colors[color] = match[2];
      found = true;
    }
  }
  const radius = text.match(/(?:borderRadius|radius)\s*:\s*["']?(\d+(?:px|rem)?)["']?/);
  if (radius && !tokens.radius) {
    tokens.radius = /^\d+$/.test(radius[1]) ? `${radius[1]}px` : radius[1];
    found = true;
  }
  const font = text.match(/fontFamily\s*:\s*["']([^"']+)["']/);
  if (font && !tokens.fonts.body && SAFE_VALUE.test(font[1])) {
    tokens.fonts.body = font[1];
    found = true;
  }
  if (found) tokens.sources.push({ file });
  return found;
}

export function discoverFrontend(repoPath: string): FrontendDiscovery {
  const root = resolve(repoPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`INSPECT_PATH_INVALID: ${repoPath} is not a directory`);
  const { files, truncated } = walk(root);
  const names = new Set<string>();
  const packageFiles = files.filter((f) => !f.dir && /(^|\/)package\.json$/.test(f.rel) && f.rel.split("/").length <= 4);
  for (const pkg of packageFiles) {
    const text = readSmall(pkg.abs);
    if (!text) continue;
    try {
      const json = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const dep of Object.keys({ ...json.dependencies, ...json.devDependencies })) for (const [label, re] of FRAMEWORKS) if (re.test(dep)) names.add(label);
    } catch {
      /* not parseable: ignore */
    }
  }
  const has = (re: RegExp) => files.some((f) => !f.dir && re.test(f.rel));
  if (has(/\.xcodeproj\/|\.swift$/)) names.add("ios-native");
  if (has(/(^|\/)build\.gradle(\.kts)?$/) && has(/\.(kt|java)$/)) names.add("android-native");
  if (has(/(^|\/)pubspec\.yaml$/)) names.add("flutter");
  const styleFiles = files.filter((f) => !f.dir && /\.(css|scss|sass|less)$/.test(f.rel) && !/\.min\./.test(f.rel)).map((f) => f.rel);
  const themeFiles = files.filter((f) => !f.dir && /(^|\/)(tailwind\.config|theme|tokens|design-tokens|colors|palette)[\w.-]*\.(js|cjs|mjs|ts|json)$/i.test(f.rel)).map((f) => f.rel);
  const componentDirs = files.filter((f) => f.dir && /(^|\/)(components|ui|widgets|shared\/ui|design-system)$/i.test(f.rel)).map((f) => f.rel);
  const screenDirs = files.filter((f) => f.dir && /(^|\/)(pages|views|routes|screens|app)$/i.test(f.rel) && !/node_modules/.test(f.rel));
  const screenCandidates = screenDirs
    .flatMap((d) => files.filter((f) => !f.dir && f.rel.startsWith(`${d.rel}/`) && f.rel.slice(d.rel.length + 1).split("/").length <= 2 && /\.(tsx|jsx|vue|svelte|swift|kt|dart)$/.test(f.rel)).map((f) => f.rel))
    .slice(0, 60);
  const tokens: FrontendDiscovery["styles"] = { colors: {}, fonts: {}, sources: [] };
  // global style files first (index/global/app/variables/theme), then the rest, so the tokens come from the file that defines them
  const ranked = [...styleFiles].sort((a, b) => Number(/(^|\/)(global|globals|index|app|main|variables|theme|tokens|root)[\w.-]*\./i.test(b)) - Number(/(^|\/)(global|globals|index|app|main|variables|theme|tokens|root)[\w.-]*\./i.test(a)));
  for (const file of ranked.slice(0, 40)) {
    const text = readSmall(join(root, file));
    if (text) tokensFromCss(text, file, tokens);
    if (Object.keys(tokens.colors).length >= 6 && tokens.fonts.body && tokens.radius) break;
  }
  for (const file of themeFiles.slice(0, 20)) {
    const text = readSmall(join(root, file));
    if (text) (file.endsWith(".json") || /\.(c|m)?[jt]s$/.test(file)) && tokensFromScript(text, file, tokens);
  }
  const frameworks = [...names].sort();
  const web = frameworks.some((f) => ["react", "next", "vue", "nuxt", "angular", "svelte", "solid"].includes(f)) || styleFiles.length > 0 || has(/\.html$/);
  const mobile = frameworks.some((f) => ["react-native", "expo", "ios-native", "android-native", "flutter"].includes(f));
  const hasStyles = Object.keys(tokens.colors).length > 0 || Boolean(tokens.fonts.body) || Boolean(tokens.radius);
  return {
    root,
    isFrontend: web || mobile,
    kind: mobile ? "mobile" : web ? "web" : "none",
    frameworks,
    styleFiles: styleFiles.slice(0, 40),
    componentDirs: componentDirs.slice(0, 20),
    screenCandidates,
    styles: tokens,
    hasStyles,
    instructionFiles: files.filter((f) => !f.dir && isAgentInstructionFile(f.rel)).map((f) => f.rel).slice(0, 40),
    scannedFiles: files.filter((f) => !f.dir).length,
    truncated,
    note: hasStyles
      ? "Tokens were parsed from the listed files. Use them in the prototype and say so."
      : web || mobile
        ? "No design tokens were found. The prototype will use neutral styles and must say so."
        : "No frontend found. For a backend-only task build an API prototype (kind api).",
  };
}
