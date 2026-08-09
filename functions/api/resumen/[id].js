// GET /api/resumen/:id -> saldo por moneda, facturas y notas de crédito/débito de un proveedor

export async function onRequestGet({ env, params }) {
  const proveedorId = params.id;

  // razón social y datos generales (proveedor_id, nombre)
  const saldo = await env.DB
    .prepare("SELECT * FROM vw_saldo_proveedor WHERE proveedor_id = ?")
    .bind(proveedorId)
    .first();

  // saldo separado por moneda: nunca se mezcla PES con DOL en un mismo total
  const saldosPorMoneda = await env.DB
    .prepare(
      `SELECT f.moneda,
              SUM(f.total) AS total_facturado,
              COALESCE((
                SELECT SUM(pf.monto_aplicado)
                FROM pago_factura pf
                JOIN facturas f2 ON f2.id = pf.factura_id
                WHERE f2.proveedor_id = ? AND f2.moneda = f.moneda
              ), 0) AS total_pagado
       FROM facturas f
       WHERE f.proveedor_id = ?
       GROUP BY f.moneda`
    )
    .bind(proveedorId, proveedorId)
    .all();

  const saldos = saldosPorMoneda.results.map((s) => ({
    moneda: s.moneda || "PES",
    total_facturado: s.total_facturado,
    total_pagado: s.total_pagado,
    saldo_pendiente: s.total_facturado - s.total_pagado,
  }));

  const facturas = await env.DB
    .prepare(
      `SELECT id, tipo_cbte, punto_venta, numero, fecha_emision, total, estado_pago, moneda, tipo_cambio
       FROM facturas WHERE proveedor_id = ? ORDER BY fecha_emision DESC`
    )
    .bind(proveedorId)
    .all();

  const notas = await env.DB
    .prepare(
      "SELECT * FROM notas_credito_debito WHERE proveedor_id = ? ORDER BY fecha_emision DESC"
    )
    .bind(proveedorId)
    .all();

  return Response.json({
    saldo: saldo || null,
    saldos_por_moneda: saldos,
    facturas: facturas.results,
    notas_credito_debito: notas.results,
  });
}