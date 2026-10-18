import db from '../../db/index.js';

export async function createSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      numero_cliente VARCHAR(50) UNIQUE NOT NULL,
      nombre VARCHAR(100),
      telefono VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS impresiones_log (
      id SERIAL PRIMARY KEY,
      nombre_impresora VARCHAR(200) NOT NULL,
      contenido_ticket TEXT,
      fecha_hora TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE impresiones_log
      ADD COLUMN IF NOT EXISTS event_key VARCHAR(255),
      ADD COLUMN IF NOT EXISTS form_token_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS form_token_expires_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS impresiones_log_event_key_unique
      ON impresiones_log (event_key)
      WHERE event_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS pagos_registrados (
      id SERIAL PRIMARY KEY,
      impresion_id INT NOT NULL REFERENCES impresiones_log(id),
      cliente_id INT REFERENCES clientes(id),
      numero_cliente VARCHAR(50) NOT NULL,
      referencia_pago VARCHAR(100) NOT NULL,
      monto DECIMAL(10, 2) NOT NULL CHECK (monto > 0),
      sincronizado_excel BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE pagos_registrados
      ADD COLUMN IF NOT EXISTS sincronizado_excel BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS pagos_registrados_excel_pendiente
      ON pagos_registrados (id)
      WHERE sincronizado_excel = FALSE;
  `);
}

try {
  await createSchema();
  console.log('[DB] Esquema listo.');
} catch (error) {
  console.error('[DB] No se pudo crear el esquema:', error);
  process.exitCode = 1;
} finally {
  await db.end();
}
