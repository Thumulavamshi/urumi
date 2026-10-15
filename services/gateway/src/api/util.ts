import type { z } from "zod";
import { HttpError } from "../auth.ts";
import type { Config } from "../config.ts";
import type { CredentialBox } from "../crypto.ts";
import type { Db } from "../db.ts";
import type { McpEndpoint } from "../mcp.ts";
import type { UpstreamManager } from "../upstreams.ts";

export interface Deps {
  db: Db;
  cfg: Config;
  box: CredentialBox;
  upstreams: UpstreamManager;
  mcp: McpEndpoint;
}

/** Validate input with zod; a failure becomes a 400 listing what was wrong. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, detail);
  }
  return result.data;
}

export function idParam(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "invalid id");
  return id;
}
