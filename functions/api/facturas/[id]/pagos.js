// GET /api/facturas/:id/pagos -> historial de pagos aplicados a esa factura

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT p.id, p.fecha_pago, p.medio_pago, p.referencia, pf.monto_aplicado
       FROM pago_factura pf
       JOIN pagos p ON p.id = pf.pago_id
       WHERE pf.factura_id = ?
       ORDER BY p.fecha_pago DESC`
    )
    .bind(params.id)
    .all();

  return Response.json(results);
}
