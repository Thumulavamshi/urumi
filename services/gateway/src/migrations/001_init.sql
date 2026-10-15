-- Initial schema. Migrations are plain SQL, applied in filename order on
-- startup inside one transaction each, under a Postgres advisory lock so
-- several gateway replicas starting together don't race.

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text,                       -- NULL until the invite is accepted
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One-time invite links. Only the SHA-256 of the token is stored.
CREATE TABLE invites (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_by  bigint REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Dashboard login sessions (opaque cookie; only its hash is stored, so a DB
-- leak doesn't hand out live sessions). Server-side => logout/disable is instant.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Personal API keys for MCP clients. The key itself is shown once; we keep
-- its SHA-256 (lookup on every request) and a short prefix for display.
CREATE TABLE api_keys (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    bigint REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);

-- Upstream MCP servers. The slug becomes the tool-name prefix
-- (`<slug>__<tool>`), so it is immutable and may not contain "__".
CREATE TABLE servers (
  id                bigserial PRIMARY KEY,
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,29}$'),
  name              text NOT NULL,
  url               text NOT NULL,
  auth_type         text NOT NULL CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name  text,
  credential_enc    text,                  -- AES-256-GCM, see crypto.ts
  enabled           boolean NOT NULL DEFAULT true,
  managed           boolean NOT NULL DEFAULT false,  -- registered from Helm values
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (auth_type <> 'header' OR auth_header_name IS NOT NULL)
);

-- One row per tools/call routed (or refused) by the gateway. Slugs/emails are
-- denormalised so the log stays readable after a server or user is deleted.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  user_email   text NOT NULL,
  api_key_id   bigint REFERENCES api_keys(id) ON DELETE SET NULL,
  server_id    bigint REFERENCES servers(id) ON DELETE SET NULL,
  server_slug  text,
  tool         text NOT NULL,
  via          text NOT NULL CHECK (via IN ('mcp', 'chat')),
  duration_ms  integer NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('success', 'error', 'timeout', 'denied', 'unreachable')),
  error        text
);
CREATE INDEX audit_log_at_idx ON audit_log(at DESC);
CREATE INDEX audit_log_user_idx ON audit_log(user_id, at DESC);
CREATE INDEX audit_log_server_idx ON audit_log(server_id, at DESC);
