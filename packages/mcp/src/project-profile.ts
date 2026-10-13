import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ServiceLocation = {
  id: string;
  name?: string;
  localPath?: string;
  remoteUrl?: string;
  repository?: string;
  branch?: string;
};

export type ProjectProfile = {
  serviceId: string;
  repository: string;
  localPath?: string;
  missingLocation: boolean;
  languages: string[];
  frameworks: string[];
  testRunners: string[];
  sourceFiles: string[];
  availableLevels: string[];
  unavailableLevels: string[];
};

const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "coverage"]);

function walk(root: string, dir: string, out: string[], depth: number): void {
  if (depth > 4 || out.length >= 200) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const absolute = join(dir, name);
    let info;
    try {
      info = statSync(absolute);
    } catch {
      continue;
    }
    if (info.isDirectory()) walk(root, absolute, out, depth + 1);
    else if (info.isFile()) out.push(absolute.slice(root.length + 1));
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function inspectService(service: ServiceLocation): ProjectProfile {
  const repository = service.repository ?? service.id;
  if (!service.localPath || !existsSync(service.localPath)) {
    return {
      serviceId: service.id,
      repository,
      ...(service.localPath ? { localPath: service.localPath } : {}),
      missingLocation: true,
      languages: [],
      frameworks: [],
      testRunners: [],
      sourceFiles: [],
      availableLevels: [],
      unavailableLevels: ["static", "unit", "service-integration", "api", "contract", "e2e", "browser"],
    };
  }
  const files: string[] = [];
  walk(service.localPath, service.localPath, files, 0);
  const names = new Set(files.map((file) => file.split("/").pop() ?? file));
  const languages: string[] = [];
  const frameworks: string[] = [];
  const testRunners: string[] = [];
  const packageJson = names.has("package.json") ? readJson(join(service.localPath, "package.json")) : undefined;
  const deps = {
    ...(packageJson?.dependencies as Record<string, unknown> | undefined),
    ...(packageJson?.devDependencies as Record<string, unknown> | undefined),
  };
  if (packageJson || files.some((file) => /\.(mjs|cjs|js|ts|tsx)$/.test(file))) languages.push("javascript");
  if (files.some((file) => file.endsWith(".py")) || names.has("pyproject.toml") || names.has("requirements.txt")) {
    languages.push("python");
  }
  if (names.has("go.mod")) languages.push("go");
  if (names.has("Cargo.toml")) languages.push("rust");
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) languages.push("java");
  for (const name of ["express", "fastify", "next", "react", "vue", "flask", "fastapi", "django", "spring-boot"]) {
    if (deps[name] || files.some((file) => file.toLowerCase().includes(name))) frameworks.push(name);
  }
  if (deps.vitest) testRunners.push("vitest");
  if (deps.jest) testRunners.push("jest");
  if (files.some((file) => /\.test\.(js|mjs|cjs|ts)$/.test(file))) testRunners.push("node:test");
  const pythonTests = files.filter((file) => /(^|\/)test_.*\.py$/.test(file) || file.endsWith("_test.py"));
  for (const file of pythonTests.slice(0, 20)) {
    let text = "";
    try {
      text = readFileSync(join(service.localPath, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("unittest")) testRunners.push("unittest");
    if (text.includes("pytest")) testRunners.push("pytest");
  }
  if ((names.has("pytest.ini") || names.has("conftest.py")) && !testRunners.includes("pytest")) testRunners.push("pytest");
  if (names.has("go.mod") && files.some((file) => file.endsWith("_test.go"))) testRunners.push("go test");
  if (deps["@playwright/test"] || names.has("playwright.config.ts") || names.has("playwright.config.js")) {
    testRunners.push("playwright");
  }
  if (deps.cypress || names.has("cypress.config.js") || names.has("cypress.config.ts")) testRunners.push("cypress");
  const available = ["static"];
  if (testRunners.length) available.push("unit");
  if (frameworks.some((name) => ["express", "fastify", "flask", "fastapi", "django", "spring-boot"].includes(name))) {
    available.push("api");
  }
  if (files.some((file) => /openapi|swagger/i.test(file))) available.push("contract");
  const unavailable = ["service-integration", "api", "contract", "e2e", "browser"].filter(
    (level) => !available.includes(level),
  );
  if (testRunners.includes("playwright") || testRunners.includes("cypress")) {
    available.push("browser");
    const index = unavailable.indexOf("browser");
    if (index >= 0) unavailable.splice(index, 1);
    if (!available.includes("e2e")) available.push("e2e");
    const e2e = unavailable.indexOf("e2e");
    if (e2e >= 0) unavailable.splice(e2e, 1);
  }
  return {
    serviceId: service.id,
    repository,
    localPath: service.localPath,
    missingLocation: false,
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
    testRunners: [...new Set(testRunners)],
    sourceFiles: files.filter((file) => /\.(py|js|mjs|cjs|ts|tsx|go|java|rs)$/.test(file)).slice(0, 40),
    availableLevels: available,
    unavailableLevels: unavailable,
  };
}
