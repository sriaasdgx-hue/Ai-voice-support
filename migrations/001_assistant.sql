CREATE TABLE IF NOT EXISTS assistant_conversations (
  id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', last_language text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_owner_idx ON assistant_conversations(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
  seq bigserial UNIQUE, id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  client_id text NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL DEFAULT '', mode text NOT NULL CHECK(mode IN ('text','voice')),
  status text NOT NULL CHECK(status IN ('pending','completed','interrupted','failed','truncated')),
  language text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, client_id)
);
ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;
-- Access is through the authenticated Node service using the owning database role.
-- No public/anon policies: never expose these tables using an APK service key.
