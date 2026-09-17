import { callTool, parseRole, toolsForRole, type PraxisRole } from "./tools.js";

const PROTOCOL = "2024-11-05";

function unbundledVersion(): string {
  return process.env.PRAXIS_BUNDLE_VERSION || "0.0.0";
}

export type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function parseRoleArgv(argv: string[]): PraxisRole {
  const i = argv.indexOf("--role");
  if (i >= 0) return parseRole(argv[i + 1]);
  return parseRole(process.env.PRAXIS_PLUGIN_ROLE);
}

export function encodeMcpFrame(msg: object): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, json]);
}

export function readMcpMessages(buffer: Buffer): { messages: JsonRpc[]; rest: Buffer } {
  const messages: JsonRpc[] = [];
  let rest = buffer;
  while (rest.length) {
    const parsed = readOneMessage(rest);
    if (!parsed) break;
    rest = parsed.rest;
    if (parsed.msg) messages.push(parsed.msg);
  }
  return { messages, rest };
}

function readOneMessage(buffer: Buffer): { msg: JsonRpc | null; rest: Buffer } | null {
  const text = buffer.toString("utf8");
  const headerMatch = text.match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
  if (headerMatch) {
    const headerBytes = Buffer.byteLength(headerMatch[0], "utf8");
    const length = Number(headerMatch[1]);
    if (buffer.length < headerBytes + length) return null;
    const json = buffer.slice(headerBytes, headerBytes + length).toString("utf8");
    return { msg: JSON.parse(json) as JsonRpc, rest: buffer.slice(headerBytes + length) };
  }
  const lf = buffer.indexOf(0x0a);
  if (lf < 0) return null;
  const line = buffer.slice(0, lf).toString("utf8").replace(/\r$/, "").trim();
  const rest = buffer.slice(lf + 1);
  if (!line) return { msg: null, rest };
  if (line.startsWith("Content-Length:")) return null;
  return { msg: JSON.parse(line) as JsonRpc, rest };
}

export async function handleRpc(
  msg: JsonRpc,
  role: PraxisRole,
  version: string,
): Promise<JsonRpc | undefined> {
  const method = msg.method ?? "";
  if (!method || method.startsWith("notifications/")) return undefined;
  try {
    if (method === "initialize") {
      const params = (msg.params ?? {}) as { protocolVersion?: string };
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          protocolVersion: params.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "praxis", version },
        },
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
    }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          tools: toolsForRole(role).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    }
    if (method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown };
      const envelope = await callTool(String(params.name ?? ""), params.arguments ?? {}, {
        role,
        version,
      });
      const text = JSON.stringify(envelope);
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          content: [{ type: "text", text }],
          isError: !envelope.ok,
          structuredContent: envelope,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function startStdioServer(opts?: {
  role?: PraxisRole;
  version?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): void {
  const role = opts?.role ?? parseRoleArgv(process.argv.slice(2));
  const version = opts?.version ?? unbundledVersion();
  const input = opts?.stdin ?? process.stdin;
  const output = opts?.stdout ?? process.stdout;
  let buffer = Buffer.alloc(0);
  const queue: JsonRpc[] = [];
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const msg = queue.shift()!;
      const reply = await handleRpc(msg, role, version);
      if (reply) output.write(encodeMcpFrame(reply));
    }
    pumping = false;
  }

  input.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const parsed = readMcpMessages(buffer);
    buffer = parsed.rest;
    queue.push(...parsed.messages);
    void pump();
  });
}
