CREATE TABLE IF NOT EXISTS activations (
    environment_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS environment_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS cursors (
    stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')),
    sequence INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS shell_coverage (
    id INTEGER PRIMARY KEY CHECK(id=1),
    sequence INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    document TEXT NOT NULL,
    location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')),
    revision INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS thread_revisions (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
