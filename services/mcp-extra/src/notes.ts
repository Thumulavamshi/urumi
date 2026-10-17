// notes: a tiny CRM-style follow-up notes MCP server, persisted to a JSON file
// on a volume. Callers authenticate with a custom header (X-Notes-Key by
// default) instead of a bearer token, to exercise the gateway's "header"
// credential type.
//
// It deliberately also exposes `list_orders`, the same bare name as a
// WooCommerce tool: through the gateway they appear as `woo__list_orders` and
// `notes__list_orders`, so the collision never reaches the client.
import { mkdirSync, readFileSync, writeFileSync, renameSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { fail, log, ok, required, secretMatches, serve } from "./http.ts";

interface Note {
  id: string;
  text: string;
  order_id?: number;
  customer?: string;
  tags: string[];
  created_at: string;
}

const port = Number(process.env.PORT ?? 8080);
const token = required("NOTES_AUTH_TOKEN");
const header = (process.env.NOTES_AUTH_HEADER ?? "x-notes-key").toLowerCase();
const dataDir = process.env.NOTES_DATA_DIR ?? "/data";
const file = join(dataDir, "notes.json");

// --- Storage ------------------------------------------------------------------
// The whole set lives in memory and is rewritten on every change: fine for a
// few thousand notes, one replica (the volume is ReadWriteOnce). The write goes
// to a temp file first and is renamed over the old one, so a crash mid-write
// never leaves a truncated notes.json.
mkdirSync(dataDir, { recursive: true });
let notes: Note[] = [];
try {
  notes = JSON.parse(readFileSync(file, "utf8")) as Note[];
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}
log({ msg: "notes loaded", count: notes.length, file });

function persist(): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes, null, 2));
  renameSync(tmp, file);
}

function writable(): boolean {
  try {
    accessSync(dataDir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const tag = z.string().trim().toLowerCase().min(1).max(30);

serve({
  name: "notes",
  port,
  challenge: `ApiKey header="${header}"`,
  authorize: (req) => {
    const value = req.headers[header];
    return secretMatches(Array.isArray(value) ? value[0] : value, token);
  },
  ready: writable,
  register(server) {
    server.registerTool(
      "create_note",
      {
        title: "Create note",
        description: "Save a follow-up note, optionally linked to a store order id and/or a customer, with tags like 'refund' or 'vip'.",
        inputSchema: z.object({
          text: z.string().trim().min(1).max(2000),
          order_id: z.number().int().positive().optional().describe("WooCommerce order id this note is about"),
          customer: z.string().trim().max(200).optional().describe("Customer name or email"),
          tags: z.array(tag).max(10).default([]),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ text, order_id, customer, tags }) => {
        const note: Note = {
          id: randomUUID().slice(0, 8),
          text,
          order_id,
          customer,
          tags: [...new Set(tags)],
          created_at: new Date().toISOString(),
        };
        notes.push(note);
        try {
          persist();
        } catch (err) {
          notes.pop();
          return fail(`could not save note: ${(err as Error).message}`);
        }
        return ok({ created: note });
      },
    );

    server.registerTool(
      "list_notes",
      {
        title: "List notes",
        description: "List follow-up notes, newest first, filtered by order id, tag, customer or free text.",
        inputSchema: z.object({
          order_id: z.number().int().positive().optional(),
          tag: tag.optional(),
          query: z.string().trim().min(1).optional().describe("Case-insensitive match on text or customer"),
          limit: z.number().int().min(1).max(100).default(20),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ order_id, tag: t, query, limit }) => {
        const q = query?.toLowerCase();
        const matches = notes
          .filter((n) => order_id === undefined || n.order_id === order_id)
          .filter((n) => !t || n.tags.includes(t))
          .filter((n) => !q || n.text.toLowerCase().includes(q) || (n.customer ?? "").toLowerCase().includes(q))
          .reverse();
        return ok({ total: matches.length, notes: matches.slice(0, limit) });
      },
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete note",
        description: "Delete a note by id.",
        inputSchema: z.object({ id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ id }) => {
        const index = notes.findIndex((n) => n.id === id);
        if (index === -1) return fail(`note ${id} not found`);
        const [removed] = notes.splice(index, 1);
        try {
          persist();
        } catch (err) {
          notes.splice(index, 0, removed!);
          return fail(`could not delete note: ${(err as Error).message}`);
        }
        return ok({ deleted: id });
      },
    );

    // Same bare name as WooCommerce's list_orders, on purpose (see top of file).
    server.registerTool(
      "list_orders",
      {
        title: "List orders with notes",
        description:
          "List the store order ids that have follow-up notes, with the note count and latest note per order. This does not read the store itself.",
        inputSchema: z.object({ tag: tag.optional().describe("Only count notes with this tag") }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ tag: t }) => {
        const byOrder = new Map<number, Note[]>();
        for (const n of notes) {
          if (n.order_id === undefined || (t && !n.tags.includes(t))) continue;
          byOrder.set(n.order_id, [...(byOrder.get(n.order_id) ?? []), n]);
        }
        const orders = [...byOrder.entries()]
          .map(([order_id, list]) => ({ order_id, notes: list.length, latest: list.at(-1)!.text, latest_at: list.at(-1)!.created_at }))
          .sort((a, b) => b.latest_at.localeCompare(a.latest_at));
        return ok({ total: orders.length, orders });
      },
    );
  },
});
