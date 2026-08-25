import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { QualityStore } from "./store.js";

export function createQualityApp(store: QualityStore) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "quality-service" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/metrics")) {
      const url = new URL(req.url, "http://localhost");
      const project = url.searchParams.get("project") ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.metrics(project ?? undefined)));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

export function startServer(opts: {
  store: QualityStore;
  port?: number;
}): ReturnType<typeof createServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const server = createQualityApp(opts.store);
  server.listen(port, () => {
    console.log(`quality-service listening on ${port}`);
  });
  return server;
}
