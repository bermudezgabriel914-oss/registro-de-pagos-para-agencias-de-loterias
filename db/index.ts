import { Pool } from 'pg';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  return value;
}

const port = Number(process.env.DB_PORT ?? 5432);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT debe ser un puerto válido.');
}

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port,
  user: requiredEnv('POSTGRES_USER'),
  password: requiredEnv('POSTGRES_PASSWORD'),
  database: requiredEnv('POSTGRES_DB'),
});

db.on('error', (error) => {
  console.error('[DB] Error inesperado en una conexión inactiva:', error);
});

export default db;
