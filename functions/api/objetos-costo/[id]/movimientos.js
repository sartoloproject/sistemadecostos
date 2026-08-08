// GET /api/objetos-costo/:id/movimientos
// Devuelve todo lo que se le imputó a un objeto de costo (maquinaria, lote,
// vehículo, gasto general), con el producto, el proveedor y la categoría
// de cada imputación.

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT im.id, im.monto_imputado, im.cantidad_imputada, im.porcentaje, im.creado_en,
              fi.descripcion AS producto, fi.unidad_medida,
              f.fecha_emision, f.tipo_cbte, f.punto_venta, f.numero,
              p.razon_social AS proveedor,
              c.id AS categoria_id, c.nombre AS categoria
       FROM imputaciones im
       JOIN factura_items fi ON fi.id = im.item_id
       JOIN facturas f ON f.id = fi.factura_id
       JOIN proveedores p ON p.id = f.proveedor_id
       LEFT JOIN categorias c ON c.id = im.categoria_id
       WHERE im.objeto_costo_id = ?
       ORDER BY f.fecha_emision DESC`
    )
    .bind(params.id)
    .all();

  const total = results.reduce((acc, r) => acc + r.monto_imputado, 0);

  return Response.json({ movimientos: results, total });
}
