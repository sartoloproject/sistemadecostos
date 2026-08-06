// GET /api/resumen/:id -> saldo, facturas y notas de crédito/débito de un proveedor

export async function onRequestGet({ env, params }) {
  const proveedorId = params.id;

  const saldo = await env.DB
    .prepare("SELECT * FROM vw_saldo_proveedor WHERE proveedor_id = ?")
    .bind(proveedorId)
    .first();

  const facturas = await env.DB
    .prepare(
      `SELECT id, tipo_cbte, punto_venta, numero, fecha_emision, total, estado_pago
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
    facturas: facturas.results,
    notas_credito_debito: notas.results,
  });
}
