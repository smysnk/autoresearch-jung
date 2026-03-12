#!/usr/bin/env node

const http = require("node:http");

const next = require("next");
const { WebSocket, WebSocketServer } = require("ws");

const { getAtlasWatchHub } = require("./server/live-watch-hub");

const LIVE_SOCKET_PATH = "/api/live/ws";

function parseArgs(argv) {
  const args = {
    dev: false,
    hostname: undefined,
    port: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dev") {
      args.dev = true;
      continue;
    }
    if (arg === "--hostname" && argv[index + 1]) {
      args.hostname = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--port" && argv[index + 1]) {
      args.port = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dev = args.dev || process.env.NODE_ENV !== "production";
  process.env.NODE_ENV = dev ? "development" : "production";

  const port = Number(args.port ?? process.env.PORT ?? 3000);
  const hostname = args.hostname ?? process.env.HOSTNAME ?? "0.0.0.0";
  const dir = __dirname;

  const app = next({ dev, dir, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const handleUpgrade = app.getUpgradeHandler();

  const hub = getAtlasWatchHub();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on("connection", (socket) => {
    const send = (payload) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify(payload));
    };

    send(hub.snapshot());
    const unsubscribe = hub.subscribe((payload) => {
      send(payload);
    });
    const heartbeat = setInterval(() => {
      send({ type: "ping", timestamp: new Date().toISOString() });
    }, 20000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  const server = http.createServer((request, response) => {
    handle(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url || "/";
    const host = request.headers.host || `${hostname}:${port}`;
    const pathname = new URL(requestUrl, `http://${host}`).pathname;
    if (pathname === LIVE_SOCKET_PATH) {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
      return;
    }
    handleUpgrade(request, socket, head);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });

  console.log(`Atlas server listening on http://${hostname}:${port}`);

  const shutdown = () => {
    wss.clients.forEach((client) => {
      client.close();
    });
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
