import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import db from '../../db/index.js';
import { exportPendingPayments } from '../services/excel.js';

const printSchema = z.object({
  eventKey: z.string().trim().min(1).max(255),
  printerName: z.string().trim().min(1).max(200),
  documentName: z.string().trim().max(500).default(''),
  workstation: z.string().trim().min(1).max(200),
});

const paymentSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),
  numeroCliente: z.string().trim().min(1).max(50),
  referenciaPago: z.string().trim().min(1).max(100),
  monto: z
    .number()
    .finite()
    .positive()
    .max(99_999_999.99)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
      'El monto debe tener como máximo dos decimales.',
    ),
});

function configuredApiKey(): string {
  const key = process.env.API_KEY?.trim();
  if (!key || key.length < 32) {
    throw new Error('API_KEY debe configurarse con al menos 32 caracteres.');
  }
  return key;
}

function isAuthorized(request: FastifyRequest): boolean {
  const supplied = request.headers['x-api-key'];
  if (typeof supplied !== 'string') return false;
  const expectedBuffer = Buffer.from(configuredApiKey());
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function tokenFor(eventKey: string): string {
  return createHmac('sha256', configuredApiKey()).update(eventKey).digest('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function matchesToken(supplied: string, storedHash: string): boolean {
  const suppliedHash = Buffer.from(tokenHash(supplied), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return suppliedHash.length === stored.length && timingSafeEqual(suppliedHash, stored);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] as string,
  );
}

function registrationPage(id: number, token: string): string {
  const safeToken = escapeHtml(token);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registrar pago</title>
<style>
body{font:16px system-ui,sans-serif;background:#f2f5f9;margin:0;padding:24px;color:#172033}
main{max-width:440px;margin:6vh auto;background:white;padding:28px;border-radius:12px;box-shadow:0 8px 32px #17203318}
h1{margin-top:0}label{display:block;margin:16px 0 6px;font-weight:600}
input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c3d0;border-radius:6px;font:inherit}
button{margin-top:22px;width:100%;padding:13px;background:#1759a6;color:white;border:0;border-radius:6px;font:inherit;font-weight:700;cursor:pointer}
#message{margin-top:14px} .error{color:#a21d22}
</style></head><body><main>
<h1>Registrar pago</h1><p>Complete los datos del pago para este ticket.</p>
<form id="payment-form">
<label for="numeroCliente">Número de cliente</label><input id="numeroCliente" name="numeroCliente" maxlength="50" required autofocus>
<label for="referenciaPago">Referencia del pago</label><input id="referenciaPago" name="referenciaPago" maxlength="100" required>
<label for="monto">Monto exacto</label><input id="monto" name="monto" type="number" min="0.01" max="99999999.99" step="0.01" required>
<button id="submit" type="submit">Guardar pago</button><div id="message" role="status"></div>
</form></main>
<script>
const form=document.querySelector('#payment-form'),button=document.querySelector('#submit'),message=document.querySelector('#message');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;message.textContent='Guardando...';
try{const response=await fetch('/api/impresiones/${id}/pago',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${safeToken}',numeroCliente:form.numeroCliente.value,referenciaPago:form.referenciaPago.value,monto:Number(form.monto.value)})});
const result=await response.json();if(!response.ok)throw new Error(result.message||'No se pudo guardar el pago.');
form.hidden=true;message.textContent=result.excelSynced?'Pago guardado y exportado a Excel.':'Pago guardado. La exportación a Excel está pendiente y se reintentará automáticamente.';
}catch(error){message.textContent=error.message;message.className='error';button.disabled=false;}});
</script></body></html>`;
}

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/impresiones', async (request, reply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ message: 'Credenciales del agente inválidas.' });
    }
    const parsed = printSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: 'Datos de impresión inválidos.', errors: parsed.error.issues });
    }

    const input = parsed.data;
    const token = tokenFor(input.eventKey);
    const tokenDigest = tokenHash(token);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let result = await client.query<{
        id: number;
        form_token_hash: string | null;
        form_token_expires_at: Date | null;
      }>(
        `SELECT id, form_token_hash, form_token_expires_at
         FROM impresiones_log WHERE event_key = $1 FOR UPDATE`,
        [input.eventKey],
      );
      if (result.rowCount === 0) {
        result = await client.query(
          `INSERT INTO impresiones_log
             (nombre_impresora, contenido_ticket, event_key, form_token_hash, form_token_expires_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '30 minutes')
           RETURNING id, form_token_hash, form_token_expires_at`,
          [
            input.printerName,
            JSON.stringify({ documentName: input.documentName, workstation: input.workstation }),
            input.eventKey,
            tokenDigest,
          ],
        );
      }
      const impression = result.rows[0];
      const payment = await client.query(
        'SELECT id FROM pagos_registrados WHERE impresion_id = $1',
        [impression.id],
      );
      await client.query('COMMIT');

      if (payment.rowCount) return reply.send({ status: 'registered' });
      if (
        impression.form_token_hash !== tokenDigest ||
        !impression.form_token_expires_at ||
        new Date(impression.form_token_expires_at).getTime() <= Date.now()
      ) {
        return reply.send({ status: 'expired' });
      }

      const baseUrl = (
        process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
      ).replace(/\/+$/, '');
      return reply.send({
        status: 'pending',
        formUrl: `${baseUrl}/registro/${impression.id}?token=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/registro/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      const token = request.query.token;
      if (!Number.isSafeInteger(id) || id < 1 || !token || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
        return reply.code(400).type('text/plain').send('Enlace de registro inválido.');
      }
      const result = await db.query<{
        form_token_hash: string | null;
        form_token_expires_at: Date | null;
      }>('SELECT form_token_hash, form_token_expires_at FROM impresiones_log WHERE id = $1', [id]);
      const impression = result.rows[0];
      if (
        !impression?.form_token_hash ||
        !impression.form_token_expires_at ||
        !matchesToken(token, impression.form_token_hash) ||
        new Date(impression.form_token_expires_at).getTime() <= Date.now()
      ) {
        return reply.code(410).type('text/plain').send('Este enlace ya se utilizó o venció.');
      }
      return reply.type('text/html; charset=utf-8').send(registrationPage(id, token));
    },
  );

  app.post<{ Params: { id: string } }>('/api/impresiones/:id/pago', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return reply.code(400).send({ message: 'Identificador de impresión inválido.' });
    }
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: 'Datos de pago inválidos.', errors: parsed.error.issues });
    }

    const client = await db.connect();
    let paymentId: number;
    try {
      await client.query('BEGIN');
      const impression = await client.query<{
        form_token_hash: string | null;
        form_token_expires_at: Date | null;
      }>(
        'SELECT form_token_hash, form_token_expires_at FROM impresiones_log WHERE id = $1 FOR UPDATE',
        [id],
      );
      const record = impression.rows[0];
      if (
        !record?.form_token_hash ||
        !record.form_token_expires_at ||
        !matchesToken(parsed.data.token, record.form_token_hash) ||
        new Date(record.form_token_expires_at).getTime() <= Date.now()
      ) {
        await client.query('ROLLBACK');
        return reply.code(410).send({ message: 'El enlace ya se utilizó o venció.' });
      }

      const customer = await client.query<{ id: number }>(
        `INSERT INTO clientes (numero_cliente) VALUES ($1)
         ON CONFLICT (numero_cliente) DO UPDATE SET numero_cliente = EXCLUDED.numero_cliente
         RETURNING id`,
        [parsed.data.numeroCliente],
      );
      const saved = await client.query<{ id: number }>(
        `INSERT INTO pagos_registrados
           (impresion_id, cliente_id, numero_cliente, referencia_pago, monto)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          id,
          customer.rows[0].id,
          parsed.data.numeroCliente,
          parsed.data.referenciaPago,
          parsed.data.monto,
        ],
      );
      paymentId = saved.rows[0].id;
      await client.query(
        'UPDATE impresiones_log SET form_token_hash = NULL, form_token_expires_at = NULL WHERE id = $1',
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    let excelSynced = false;
    try {
      await exportPendingPayments();
      const sync = await db.query<{ sincronizado_excel: boolean }>(
        'SELECT sincronizado_excel FROM pagos_registrados WHERE id = $1',
        [paymentId],
      );
      excelSynced = sync.rows[0]?.sincronizado_excel ?? false;
    } catch (error) {
      request.log.error({ err: error, paymentId }, 'Pago guardado; exportación a Excel pendiente');
    }
    return reply.code(201).send({ id: paymentId, excelSynced });
  });
}
