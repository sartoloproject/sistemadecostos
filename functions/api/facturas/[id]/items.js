// GET /api/facturas/:id/items -> ítems de una factura, con lo ya imputado

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT fi.*,
              COALESCE((SELECT SUM(im.monto_imputado) FROM imputaciones im WHERE im.item_id = fi.id), 0) AS monto_ya_imputado
       FROM factura_items fi
       WHERE fi.factura_id = ?`
    )
    .bind(params.id)
    .all();

  return Response.json(results);
}
