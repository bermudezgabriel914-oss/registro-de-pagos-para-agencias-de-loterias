import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import db from '../../db/index.js';

const excelPath = path.resolve(process.env.EXCEL_FILE_PATH ?? './data/pagos_loterias.xlsx');
let activeExport: Promise<number> | undefined;

async function appendPayment(row: {
  id: number;
  impresion_id: number;
  numero_cliente: string;
  referencia_pago: string;
  monto: string;
  created_at: Date;
}): Promise<void> {
  await fs.mkdir(path.dirname(excelPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(excelPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let sheet = workbook.getWorksheet('Pagos Agencias');
  if (!sheet) {
    sheet = workbook.addWorksheet('Pagos Agencias');
  }
  sheet.columns = [
    { header: 'ID Pago', key: 'id', width: 12 },
    { header: 'ID Impresión', key: 'impresionId', width: 16 },
    { header: 'Número de cliente', key: 'numeroCliente', width: 22 },
    { header: 'Referencia de pago', key: 'referenciaPago', width: 28 },
    { header: 'Monto exacto', key: 'monto', width: 16 },
    { header: 'Fecha y hora', key: 'createdAt', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };

  if (sheet.getColumn(1).values.some((value) => Number(value) === row.id)) return;

  const newRow = sheet.addRow({
    id: row.id,
    impresionId: row.impresion_id,
    numeroCliente: row.numero_cliente,
    referenciaPago: row.referencia_pago,
    monto: Number(row.monto),
    createdAt: row.created_at,
  });
  newRow.getCell('monto').numFmt = '"$"#,##0.00';
  newRow.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
  await workbook.xlsx.writeFile(excelPath);
}

export function exportPendingPayments(): Promise<number> {
  if (activeExport) return activeExport;

  activeExport = (async () => {
    const result = await db.query<{
      id: number;
      impresion_id: number;
      numero_cliente: string;
      referencia_pago: string;
      monto: string;
      created_at: Date;
    }>(
      `SELECT id, impresion_id, numero_cliente, referencia_pago, monto, created_at
       FROM pagos_registrados
       WHERE sincronizado_excel = FALSE
       ORDER BY id
       LIMIT 100`,
    );

    let exported = 0;
    for (const payment of result.rows) {
      await appendPayment(payment);
      await db.query('UPDATE pagos_registrados SET sincronizado_excel = TRUE WHERE id = $1', [
        payment.id,
      ]);
      exported++;
    }
    return exported;
  })().finally(() => {
    activeExport = undefined;
  });

  return activeExport;
}
