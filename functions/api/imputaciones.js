// POST /api/imputaciones
//   body: { item_id, objeto_costo_id, cantidad_imputada? , porcentaje? }
// Podés llamar este endpoint varias veces sobre el mismo item_id para
// repartirlo entre distintos objetos de costo (ej. gasoil entre 3 tractores).

export async function onRequestPost({ request, env }) {
  const { item_id, objeto_costo_id, cantidad_imputada, porcentaje } = await request.json();

  if (!item_id || !objeto_costo_id) {
    return new Response("'item_id' y 'objeto_costo_id' son requeridos", { status: 400 });
  }
  if (cantidad_imputada == null && porcentaje == null) {
    return new Response("Especificá 'cantidad_imputada' o 'porcentaje'", { status: 400 });
  }

  const item = await env.DB
    .prepare("SELECT precio_unitario, subtotal FROM factura_items WHERE id = ?")
    .bind(item_id)
    .first();

  if (!item) {
    return new Response("Ítem no encontrado", { status: 404 });
  }

  const monto =
    cantidad_imputada != null
      ? cantidad_imputada * item.precio_unitario
      : (item.subtotal * porcentaje) / 100;

  await env.DB
    .prepare(
      `INSERT INTO imputaciones (item_id, objeto_costo_id, cantidad_imputada, porcentaje, monto_imputado)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(item_id, objeto_costo_id, cantidad_imputada ?? null, porcentaje ?? null, monto)
    .run();

  const totalImputado = await env.DB
    .prepare("SELECT COALESCE(SUM(monto_imputado), 0) AS total FROM imputaciones WHERE item_id = ?")
    .bind(item_id)
    .first();

  if (totalImputado.total >= item.subtotal) {
    await env.DB
      .prepare("UPDATE factura_items SET imputado_completo = 1 WHERE id = ?")
      .bind(item_id)
      .run();
  }

  return Response.json({ ok: true, monto_imputado: monto }, { status: 201 });
}
