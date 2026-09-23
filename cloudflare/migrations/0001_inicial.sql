-- Esquema inicial de la base de datos D1
CREATE TABLE IF NOT EXISTS gastos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    descripcion    TEXT    NOT NULL,
    categoria      TEXT    NOT NULL DEFAULT 'General',
    monto_centavos INTEGER NOT NULL CHECK (monto_centavos > 0),
    fecha          TEXT    NOT NULL,
    vence          TEXT,
    notas          TEXT    NOT NULL DEFAULT '',
    creado         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pagos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    gasto_id       INTEGER NOT NULL REFERENCES gastos(id) ON DELETE CASCADE,
    monto_centavos INTEGER NOT NULL CHECK (monto_centavos > 0),
    fecha          TEXT    NOT NULL,
    nota           TEXT    NOT NULL DEFAULT '',
    creado         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_gasto ON pagos(gasto_id);

-- Contador que sube con cada cambio; los dispositivos lo consultan para
-- saber si deben recargar los datos.
CREATE TABLE IF NOT EXISTS meta (
    clave TEXT PRIMARY KEY,
    valor INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (clave, valor) VALUES ('version', 0);
