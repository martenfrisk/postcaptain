/** Local dashboard over the event store (see §9). Built out in task #5. */

import { EventStore } from "./store.ts";

export function startServer(dbPath: string, port: number): void {
  const store = new EventStore(dbPath);
  const server = Bun.serve({
    port,
    fetch() {
      return new Response(`postcaptain dashboard — ${store.count()} events`, {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  console.log(`dashboard: http://localhost:${server.port}  (db: ${dbPath})`);
}
