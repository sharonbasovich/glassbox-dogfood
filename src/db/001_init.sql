-- Glassbox schema v1. Timestamps are ISO-8601 UTC strings; ids are prefixed text.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT,
  platform_role  TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user', 'organizer', 'admin')),
  created_at     TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('browser', 'api')),
  label       TEXT NOT NULL DEFAULT '',
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE account_claims (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE events (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  tagline               TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  visibility            TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('draft', 'public')),
  submissions_open_at   TEXT NOT NULL,
  submissions_close_at  TEXT NOT NULL,
  judging_close_at      TEXT,
  max_team_size         INTEGER NOT NULL DEFAULT 4 CHECK (max_team_size BETWEEN 1 AND 20),
  reviews_per_project   INTEGER NOT NULL DEFAULT 3 CHECK (reviews_per_project BETWEEN 1 AND 20),
  normalization         TEXT NOT NULL DEFAULT 'zscore_shrunk' CHECK (normalization IN ('none', 'zscore_shrunk')),
  shrinkage_k           REAL NOT NULL DEFAULT 3 CHECK (shrinkage_k >= 0),
  results_published_at  TEXT,
  source_ref            TEXT,
  created_by            TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL,
  CHECK (submissions_close_at > submissions_open_at),
  CHECK (judging_close_at IS NULL OR judging_close_at >= submissions_close_at)
);

-- Per-event roles. "participant" is granted by joining a team; a person cannot
-- be both judge and participant in one event (enforced in services/roles.ts).
CREATE TABLE event_roles (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('organizer', 'judge', 'participant')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id, role)
);
CREATE INDEX event_roles_user ON event_roles(user_id);

CREATE TABLE tracks (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  source_ref   TEXT,
  UNIQUE (event_id, name)
);

CREATE TABLE prizes (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  track_id     TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE judge_tracks (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, judge_id, track_id)
);

CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  invite_code  TEXT NOT NULL UNIQUE,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  source_ref   TEXT,
  UNIQUE (event_id, name)
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id),
  UNIQUE (event_id, user_id)          -- one team per person per event
);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  track_id      TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  repo_url      TEXT NOT NULL DEFAULT '',
  demo_url      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_at  TEXT,
  duplicate_of  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  source_ref    TEXT,
  CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  CHECK (duplicate_of IS NULL OR duplicate_of <> id)
);
-- A team has exactly one canonical entry; extra entries must be marked as duplicates.
CREATE UNIQUE INDEX projects_one_canonical_per_team ON projects(team_id) WHERE duplicate_of IS NULL;
CREATE INDEX projects_event ON projects(event_id, status);

CREATE TABLE deadline_extensions (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  until       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  granted_by  TEXT REFERENCES users(id),
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
);

CREATE TABLE criteria (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  weight       REAL NOT NULL CHECK (weight > 0),
  scale_min    INTEGER NOT NULL DEFAULT 1,
  scale_max    INTEGER NOT NULL DEFAULT 5,
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, key),
  CHECK (scale_max > scale_min)
);

CREATE TABLE conflicts (
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  declared_by  TEXT REFERENCES users(id),
  declared_at  TEXT NOT NULL,
  PRIMARY KEY (event_id, judge_id, team_id)
);

CREATE TABLE assignments (
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'import')),
  assigned_by  TEXT REFERENCES users(id),
  assigned_at  TEXT NOT NULL,
  PRIMARY KEY (judge_id, project_id)
);
CREATE INDEX assignments_project ON assignments(project_id);
CREATE INDEX assignments_event ON assignments(event_id, judge_id);

-- A score can only exist for an assignment: the composite FK makes
-- "judge scored a project they were never given" unrepresentable.
CREATE TABLE scores (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id    TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (judge_id, project_id),
  FOREIGN KEY (judge_id, project_id) REFERENCES assignments(judge_id, project_id) ON DELETE CASCADE
);
CREATE INDEX scores_event ON scores(event_id);

CREATE TABLE score_values (
  score_id      TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  value         REAL NOT NULL,
  PRIMARY KEY (score_id, criterion_id)
);

-- Frozen, hashed results. Publishing never recomputes history.
CREATE TABLE result_publications (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  published_by  TEXT REFERENCES users(id),
  published_at  TEXT NOT NULL,
  retracted_at  TEXT
);

-- Append-only, hash-chained audit trail. Triggers forbid UPDATE and DELETE.
CREATE TABLE audit_log (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_id      TEXT,
  actor_label   TEXT NOT NULL,
  event_id      TEXT,
  action        TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_event ON audit_log(event_id, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
