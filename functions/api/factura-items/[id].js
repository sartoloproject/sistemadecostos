// PATCH  /api/factura-items/:id -> edita campos de un ítem
// DELETE /api/factura-items/:id -> elimina un ítem — bloquea si ya tiene
//         imputaciones registradas, para no perder esa asignación de
//         costos sin querer.

export async function onRequestPatch({ request, env, params }) {
  try {
    const body = await request.json();
    const campos = [
      "descripcion", "cantidad", "unidad_medida",
      "precio_unitario", "alicuota_iva", "subtotal", "subtotal_con_iva",
    ];
    const actualizaciones = campos.filter((c) => body[c] !== undefined);

    if (actualizaciones.length === 0) {
      return new Response("No se envió ningún campo para actualizar", { status: 400 });
    }

    const setClause = actualizaciones.map((c) => `${c} = ?`).join(", ");
    const valores = actualizaciones.map((c) => body[c]);

    const actualizado = await env.DB
      .prepare(`UPDATE factura_items SET ${setClause} WHERE id = ? RETURNING *`)
      .bind(...valores, params.id)
      .first();

    if (!actualizado) {
      return new Response("Ítem no encontrado", { status: 404 });
    }

    return Response.json(actualizado);
  } catch (error) {
    return new Response("Error actualizando el ítem: " + error.message, { status: 500 });
  }
}

export async function onRequestDelete({ env, params }) {
  try {
    const imputaciones = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM imputaciones WHERE item_id = ?")
      .bind(params.id)
      .first();

    if (imputaciones.c > 0) {
      return new Response(
        "Este ítem ya tiene imputaciones registradas. Eliminalas primero (historial, en la pestaña Imputar) antes de borrar el ítem.",
        { status: 409 }
      );
    }

    const resultado = await env.DB
      .prepare("DELETE FROM factura_items WHERE id = ? RETURNING id")
      .bind(params.id)
      .first();

    if (!resultado) {
      return new Response("Ítem no encontrado", { status: 404 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    return new Response("Error eliminando el ítem: " + error.message, { status: 500 });
  }
}
