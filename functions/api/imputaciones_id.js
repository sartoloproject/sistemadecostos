// PATCH  /api/imputaciones/:id  -> corrige cantidad_imputada o porcentaje
// DELETE /api/imputaciones/:id  -> elimina la imputación
// Ambas recalculan el estado (completo/pendiente) del ítem afectado.

async function recalcularEstadoItem(itemId, env) {
  const item = await env.DB
    .prepare("SELECT subtotal, subtotal_con_iva FROM factura_items WHERE id = ?")
    .bind(itemId)
    .first();

  if (!item) return;

  const baseTotal = item.subtotal_con_iva ?? item.subtotal;

  const totalImputado = await env.DB
    .prepare("SELECT COALESCE(SUM(monto_imputado), 0) AS total FROM imputaciones WHERE item_id = ?")
    .bind(itemId)
    .first();

  const completo = totalImputado.total >= baseTotal - 0.005;

  await env.DB
    .prepare("UPDATE factura_items SET imputado_completo = ? WHERE id = ?")
    .bind(completo ? 1 : 0, itemId)
    .run();
}

export async function onRequestDelete({ env, params }) {
  try {
    const imputacion = await env.DB
      .prepare("SELECT item_id FROM imputaciones WHERE id = ?")
      .bind(params.id)
      .first();

    if (!imputacion) {
      return new Response("Imputación no encontrada", { status: 404 });
    }

    await env.DB.prepare("DELETE FROM imputaciones WHERE id = ?").bind(params.id).run();
    await recalcularEstadoItem(imputacion.item_id, env);

    return Response.json({ ok: true });
  } catch (error) {
    return new Response("Error eliminando la imputación: " + error.message, { status: 500 });
  }
}

export async function onRequestPatch({ request, env, params }) {
  try {
    const { cantidad_imputada, porcentaje } = await request.json();

    if (cantidad_imputada == null && porcentaje == null) {
      return new Response("Especificá 'cantidad_imputada' o 'porcentaje'", { status: 400 });
    }

    const imputacion = await env.DB
      .prepare("SELECT item_id FROM imputaciones WHERE id = ?")
      .bind(params.id)
      .first();

    if (!imputacion) {
      return new Response("Imputación no encontrada", { status: 404 });
    }

    const item = await env.DB
      .prepare("SELECT cantidad, subtotal, subtotal_con_iva FROM factura_items WHERE id = ?")
      .bind(imputacion.item_id)
      .first();

    const baseTotal = item.subtotal_con_iva ?? item.subtotal;
    const precioUnitarioConIva = item.cantidad ? baseTotal / item.cantidad : 0;

    const monto =
      cantidad_imputada != null
        ? cantidad_imputada * precioUnitarioConIva
        : (baseTotal * porcentaje) / 100;

    await env.DB
      .prepare(
        "UPDATE imputaciones SET cantidad_imputada = ?, porcentaje = ?, monto_imputado = ? WHERE id = ?"
      )
      .bind(cantidad_imputada ?? null, porcentaje ?? null, monto, params.id)
      .run();

    await recalcularEstadoItem(imputacion.item_id, env);

    return Response.json({ ok: true, monto_imputado: monto });
  } catch (error) {
    return new Response("Error editando la imputación: " + error.message, { status: 500 });
  }
}
