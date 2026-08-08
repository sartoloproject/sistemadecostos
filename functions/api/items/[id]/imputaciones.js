// GET /api/items/:id/imputaciones -> historial de imputaciones de un ítem,
// con el nombre del objeto de costo ya resuelto.

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT im.id, im.objeto_costo_id, im.cantidad_imputada, im.porcentaje,
              im.monto_imputado, im.creado_en,
              oc.tipo AS objeto_tipo, oc.nombre AS objeto_nombre
       FROM imputaciones im
       JOIN objetos_costo oc ON oc.id = im.objeto_costo_id
       WHERE im.item_id = ?
       ORDER BY im.creado_en DESC`
    )
    .bind(params.id)
    .all();

  return Response.json(results);
}
