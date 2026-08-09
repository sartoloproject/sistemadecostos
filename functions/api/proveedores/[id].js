// PATCH /api/proveedores/:id
//   body: { razon_social?, condicion_iva?, email?, telefono?, direccion?, rubro? }
// Solo actualiza los campos que vengan en el body; el resto queda igual.

export async function onRequestPatch({ request, env, params }) {
  try {
    const body = await request.json();
    const campos = ["razon_social", "condicion_iva", "email", "telefono", "direccion", "rubro"];

    const actualizaciones = campos.filter((campo) => body[campo] !== undefined);
    if (actualizaciones.length === 0) {
      return new Response("No se envió ningún campo para actualizar", { status: 400 });
    }

    const setClause = actualizaciones.map((campo) => `${campo} = ?`).join(", ");
    const valores = actualizaciones.map((campo) => body[campo]);

    const actualizado = await env.DB
      .prepare(`UPDATE proveedores SET ${setClause} WHERE id = ? RETURNING *`)
      .bind(...valores, params.id)
      .first();

    if (!actualizado) {
      return new Response("Proveedor no encontrado", { status: 404 });
    }

    return Response.json(actualizado);
  } catch (error) {
    return new Response("Error actualizando el proveedor: " + error.message, { status: 500 });
  }
}
