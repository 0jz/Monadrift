// Chain-free dev server: serves frontend/ and the real-time game only (no .env, no RPC).
//   node backend/scripts/rt-dev.js [port=8788]   then open /race-rt.html
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { initRt } from "../src/rt/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
const rt = initRt(app);
app.use(express.static(path.join(here, "../../frontend")));
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://x").pathname === "/rt/ws") rt.handleUpgrade(req, socket, head); else socket.destroy();
});
const port = Number(process.argv[2] ?? 8788);
server.listen(port, () => console.log(`rt dev server: http://localhost:${port}/race-rt.html`));
