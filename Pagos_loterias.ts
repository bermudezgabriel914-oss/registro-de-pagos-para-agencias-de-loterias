import { Pool } from 'pg';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

// Cargar configuración de base de datos desde config.json
const configFile = fs.readFileSync('./config.json', 'utf-8');
const dbConfig = JSON.parse(configFile);

const pool = new Pool(dbConfig);
const EXCEL_FILE_PATH = path.join(__dirname, 'pagos_loterias.xlsx');

interface DatosPopup {
  impresionId: number;
  numeroCliente: string;
  referenciaPago: string;
  monto: number;
}

export async function registrarPagoAutomatico(datos: DatosPopup) {
  const client = await pool.connect();

  try {
    // 1. Iniciar transacción en la base de datos
    await client.query('BEGIN');

    // Insertar en la tabla pagos_registrados
    const querySQL = `
      INSERT INTO pagos_registrados (impresion_id, numero_cliente, referencia_pago, monto, sincronizado_excel)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, created_at;
    `;
    
    const values = [datos.impresionId, datos.numeroCliente, datos.referenciaPago, datos.monto];
    const result = await client.query(querySQL, values);
    const nuevoPago = result.rows[0];

    await client.query('COMMIT');
    console.log(`[DB] Pago registrado exitosamente con ID: ${nuevoPago.id}`);

    // 2. Guardado automático en Excel
    await guardarEnExcel({
      id: nuevoPago.id,
      ...datos,
      createdAt: nuevoPago.created_at
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Error] Falló el registro y la sincronización automática:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function guardarEnExcel(registro: { id: number; impresionId: number; numeroCliente: string; referenciaPago: string; monto: number; createdAt: Date }) {
  const workbook = new ExcelJS.Workbook();
  let worksheet: ExcelJS.Worksheet;

  // Verificar si el archivo Excel ya existe para abrirlo o crearlo de cero
  if (fs.existsSync(EXCEL_FILE_PATH)) {
    await workbook.xlsx.readFile(EXCEL_FILE_PATH);
    worksheet = workbook.getWorksheet('Pagos Agencias') || workbook.addWorksheet('Pagos Agencias');
  } else {
    worksheet = workbook.addWorksheet('Pagos Agencias');
    
    // Definir cabeceras profesionales si el archivo es nuevo
    worksheet.columns = [
      { header: 'ID Pago', key: 'id', width: 10 },
      { header: 'ID Impresión', key: 'impresionId', width: 15 },
      { header: 'Nº Cliente', key: 'numeroCliente', width: 20 },
      { header: 'Referencia de Pago', key: 'referenciaPago', width: 25 },
      { header: 'Monto Exacto', key: 'monto', width: 15 },
      { header: 'Fecha y Hora', key: 'createdAt', width: 22 }
    ];

    // Estilar la fila de cabecera
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '1F4E78' } // Azul corporativo oscuro
    };
  }

  // Agregar la nueva fila con los datos obtenidos del popup
  const nuevaFila = worksheet.addRow({
    id: registro.id,
    impresionId: registro.impresionId,
    numeroCliente: registro.numeroCliente,
    referenciaPago: registro.referenciaPago,
    monto: registro.monto,
    createdAt: registro.createdAt
  });

  // Formato de moneda para la columna de monto
  nuevaFila.getCell('monto').numFmt = '"$"#,##0.00';

  // Guardar los cambios automáticamente en el archivo físico
  await workbook.xlsx.writeFile(EXCEL_FILE_PATH);
  console.log(`[Excel] Archivo actualizado automáticamente en: ${EXCEL_FILE_PATH}`);
}