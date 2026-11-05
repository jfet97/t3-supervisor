CREATE TABLE dashboard_login_grants (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at)
      ) STRICT;

CREATE TABLE dashboard_login_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at AND expires_at - issued_at <= 2592000000)
      ) STRICT;
