// POST /api/imputaciones
//   body: { item_id, objeto_costo_id, cantidad_imputada? , porcentaje? }
// Podés llamar este endpoint varias veces sobre el mismo item_id para
// repartirlo entre distintos objetos de costo (ej. gasoil entre 3 tractores).
//
// La base de cálculo es el subtotal CON IVA (lo que efectivamente se paga).
// Si algún ítem viejo no tiene subtotal_con_iva cargado, se usa el neto
// como respaldo para no romper.

export async function onRequestPost({ request, env }) {
  try {
    const { item_id, objeto_costo_id, cantidad_imputada, porcentaje } = await request.json();

    if (!item_id || !objeto_costo_id) {
      return new Response("'item_id' y 'objeto_costo_id' son requeridos", { status: 400 });
    }
    if (cantidad_imputada == null && porcentaje == null) {
      return new Response("Especificá 'cantidad_imputada' o 'porcentaje'", { status: 400 });
    }

    const item = await env.DB
      .prepare("SELECT cantidad, precio_unitario, subtotal, subtotal_con_iva FROM factura_items WHERE id = ?")
      .bind(item_id)
      .first();

    if (!item) {
      return new Response("Ítem no encontrado", { status: 404 });
    }

    const baseTotal = item.subtotal_con_iva ?? item.subtotal; // fallback si no hay c/IVA cargado
    const precioUnitarioConIva = item.cantidad ? baseTotal / item.cantidad : item.precio_unitario;

    const monto =
      cantidad_imputada != null
        ? cantidad_imputada * precioUnitarioConIva
        : (baseTotal * porcentaje) / 100;

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

    const completo = totalImputado.total >= baseTotal;

    if (completo) {
      await env.DB
        .prepare("UPDATE factura_items SET imputado_completo = 1 WHERE id = ?")
        .bind(item_id)
        .run();
    }

    return Response.json(
      {
        ok: true,
        monto_imputado: monto,
        total_imputado: totalImputado.total,
        base_total: baseTotal,
        completo,
        restante: Math.max(0, baseTotal - totalImputado.total),
      },
      { status: 201 }
    );
  } catch (error) {
    return new Response("Error interno al imputar: " + error.message, { status: 500 });
  }
}