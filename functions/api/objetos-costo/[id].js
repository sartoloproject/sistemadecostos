// PATCH  /api/objetos-costo/:id -> edita tipo, nombre o identificador
// DELETE /api/objetos-costo/:id -> elimina el objeto de costo — bloquea
//         si ya tiene imputaciones registradas, para no perder ese
//         historial sin querer.

export async function onRequestPatch({ request, env, params }) {
  try {
    const body = await request.json();
    const campos = ["tipo", "nombre", "identificador"];
    const actualizaciones = campos.filter((c) => body[c] !== undefined);

    if (actualizaciones.length === 0) {
      return new Response("No se envió ningún campo para actualizar", { status: 400 });
    }

    const setClause = actualizaciones.map((c) => `${c} = ?`).join(", ");
    const valores = actualizaciones.map((c) => body[c]);

    const actualizado = await env.DB
      .prepare(`UPDATE objetos_costo SET ${setClause} WHERE id = ? RETURNING *`)
      .bind(...valores, params.id)
      .first();

    if (!actualizado) {
      return new Response("Objeto de costo no encontrado", { status: 404 });
    }

    return Response.json(actualizado);
  } catch (error) {
    return new Response("Error actualizando el objeto de costo: " + error.message, { status: 500 });
  }
}

export async function onRequestDelete({ env, params }) {
  try {
    const imputaciones = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM imputaciones WHERE objeto_costo_id = ?")
      .bind(params.id)
      .first();

    if (imputaciones.c > 0) {
      return new Response(
        "Este objeto de costo tiene imputaciones registradas. Eliminalas primero (o reasignalas) antes de borrarlo.",
        { status: 409 }
      );
    }

    const resultado = await env.DB
      .prepare("DELETE FROM objetos_costo WHERE id = ? RETURNING id")
      .bind(params.id)
      .first();

    if (!resultado) {
      return new Response("Objeto de costo no encontrado", { status: 404 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    return new Response("Error eliminando el objeto de costo: " + error.message, { status: 500 });
  }
}
