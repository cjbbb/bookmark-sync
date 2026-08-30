import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolve } from "node:path";
import { validateRepository } from "@bookmark-sync/core";
import type { BookmarkRepository, CommitMetadata } from "@bookmark-sync/core";
import { SnapshotDatabase } from "./database.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const apiToken = process.env.SYNC_API_TOKEN;
const databasePath = resolve(process.env.SYNC_DB_PATH ?? "./data/bookmarks.sqlite");

if (!apiToken) throw new Error("SYNC_API_TOKEN is required");

const database = new SnapshotDatabase(databasePath);
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  const authorization = request.headers.authorization ?? "";
  if (authorization !== `Bearer ${apiToken}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true, service: "bookmark-sync-server" }));

app.get("/api/repository", async (request, reply) => {
  const repository = database.getCurrent();
  if (!repository) return reply.code(404).send({ error: "Repository is not initialized" });
  return { repository };
});

app.put("/api/repository", async (request, reply) => {
  const body = request.body as { repository?: BookmarkRepository; metadata?: CommitMetadata } | undefined;
  const repository = body?.repository;
  if (!repository) return reply.code(400).send({ error: "repository is required" });
  const errors = validateRepository(repository);
  if (errors.length) return reply.code(400).send({ error: errors.join(", ") });
  const result = database.save(repository, body?.metadata?.message ?? `Bookmark sync revision ${repository.revision}`, body?.metadata?.author);
  return result;
});

app.get("/api/history", async () => database.getHistory());

app.get<{ Params: { id: string } }>("/api/history/:id", async (request, reply) => {
  const repository = database.getVersion(request.params.id);
  if (!repository) return reply.code(404).send({ error: "History version not found" });
  return { repository };
});

app.post<{ Params: { id: string } }>("/api/history/:id/restore", async (request, reply) => {
  const repository = database.getVersion(request.params.id);
  if (!repository) return reply.code(404).send({ error: "History version not found" });
  const result = database.save(repository, `Restored snapshot ${request.params.id}`);
  return result;
});

const close = async () => {
  database.close();
  await app.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ port, host });
console.log(`Bookmark Sync server listening on http://${host}:${port}`);
