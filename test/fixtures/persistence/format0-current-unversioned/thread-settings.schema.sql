CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);

INSERT OR IGNORE INTO settings VALUES(1,'{"generation":1,"excludedThreadIds":["fixture-thread-config-excluded"]}');
