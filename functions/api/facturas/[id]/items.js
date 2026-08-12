// GET  /api/facturas/:id/items -> ítems de una factura, con lo ya imputado
// POST /api/facturas/:id/items -> agrega un ítem nuevo a una factura ya guardada

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

export async function onRequestPost({ request, env, params }) {
  try {
    const item = await request.json();

    if (!item.descripcion) {
      return new Response("'descripcion' es requerida", { status: 400 });
    }

    const nuevo = await env.DB
      .prepare(
        `INSERT INTO factura_items (factura_id, descripcion, cantidad, unidad_medida,
                                     precio_unitario, alicuota_iva, subtotal, subtotal_con_iva)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .bind(
        params.id,
        item.descripcion,
        item.cantidad || 0,
        item.unidad_medida || "unidad",
        item.precio_unitario || 0,
        item.alicuota_iva ?? 21,
        item.subtotal || 0,
        item.subtotal_con_iva || null
      )
      .first();

    return Response.json(nuevo, { status: 201 });
  } catch (error) {
    return new Response("Error agregando el ítem: " + error.message, { status: 500 });
  }
}