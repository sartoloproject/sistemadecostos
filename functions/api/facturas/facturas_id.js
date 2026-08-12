// GET    /api/facturas/:id -> una factura puntual
// PATCH  /api/facturas/:id -> edita campos de la cabecera
// DELETE /api/facturas/:id -> elimina la factura completa (ítems e
//         imputaciones en cascada). Bloquea si tiene pagos registrados,
//         para no perder ese rastro sin querer — hay que borrarlos
//         primero desde "Ver pagos".

export async function onRequestGet({ env, params }) {
  const factura = await env.DB.prepare("SELECT * FROM facturas WHERE id = ?").bind(params.id).first();
  if (!factura) {
    return new Response("Factura no encontrada", { status: 404 });
  }
  return Response.json(factura);
}

export async function onRequestPatch({ request, env, params }) {
  try {
    const body = await request.json();
    const campos = [
      "numero", "punto_venta", "tipo_cbte", "fecha_emision",
      "cae", "moneda", "tipo_cambio", "total",
    ];
    const actualizaciones = campos.filter((c) => body[c] !== undefined);

    if (actualizaciones.length === 0) {
      return new Response("No se envió ningún campo para actualizar", { status: 400 });
    }

    const setClause = actualizaciones.map((c) => `${c} = ?`).join(", ");
    const valores = actualizaciones.map((c) => body[c]);

    const actualizado = await env.DB
      .prepare(`UPDATE facturas SET ${setClause} WHERE id = ? RETURNING *`)
      .bind(...valores, params.id)
      .first();

    if (!actualizado) {
      return new Response("Factura no encontrada", { status: 404 });
    }

    return Response.json(actualizado);
  } catch (error) {
    return new Response("Error actualizando la factura: " + error.message, { status: 500 });
  }
}

export async function onRequestDelete({ env, params }) {
  try {
    const pagosAsociados = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM pago_factura WHERE factura_id = ?")
      .bind(params.id)
      .first();

    if (pagosAsociados.c > 0) {
      return new Response(
        "Esta factura tiene pagos registrados. Eliminá esos pagos primero (botón 'Ver pagos') antes de borrar la factura.",
        { status: 409 }
      );
    }

    // borramos en orden: imputaciones de sus ítems -> ítems -> la factura
    await env.DB
      .prepare(
        "DELETE FROM imputaciones WHERE item_id IN (SELECT id FROM factura_items WHERE factura_id = ?)"
      )
      .bind(params.id)
      .run();

    await env.DB.prepare("DELETE FROM factura_items WHERE factura_id = ?").bind(params.id).run();

    const resultado = await env.DB
      .prepare("DELETE FROM facturas WHERE id = ? RETURNING id")
      .bind(params.id)
      .first();

    if (!resultado) {
      return new Response("Factura no encontrada", { status: 404 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    return new Response("Error eliminando la factura: " + error.message, { status: 500 });
  }
}
