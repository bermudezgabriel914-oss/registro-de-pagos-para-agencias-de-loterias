import Fastify from 'fastify';
import db from '../db/index.js';
import { paymentRoutes } from './routes/payments.js';
import { exportPendingPayments } from './services/excel.js';

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT debe ser un puerto válido.');
}
if (!process.env.API_KEY || process.env.API_KEY.trim().length < 32) {
  throw new Error('Configura API_KEY con al menos 32 caracteres en .env.');
}

app.get('/health', async (_request, reply) => {
  await db.query('SELECT 1');
  return reply.send({ status: 'ok' });
});
await app.register(paymentRoutes);

const exportTimer = setInterval(() => {
  void exportPendingPayments().catch((error: unknown) => {
    app.log.error({ err: error }, 'No se pudieron exportar los pagos pendientes a Excel');
  });
}, 30_000);
exportTimer.unref();

try {
  await app.listen({ host, port });
  app.log.info(`Backend escuchando en http://${host}:${port}`);
} catch (error) {
  clearInterval(exportTimer);
  app.log.error(error);
  await db.end();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(exportTimer);
    await app.close();
    await db.end();
  });
}
