// GET /api/objetos-costo/:id/movimientos
// Devuelve todo lo que se le imputó a un objeto de costo (maquinaria, lote,
// vehículo, gasto general), con el producto, el proveedor y la categoría
// de cada imputación, más un resumen agrupado por categoría/subcategoría
// con totales separados por moneda y por unidad de medida (no se pueden
// sumar pesos con dólares, ni kilos con litros).

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT im.id, im.monto_imputado, im.cantidad_imputada, im.porcentaje, im.creado_en,
              fi.descripcion AS producto, fi.unidad_medida,
              f.fecha_emision, f.tipo_cbte, f.punto_venta, f.numero, f.moneda,
              p.razon_social AS proveedor,
              c.id AS categoria_id, c.nombre AS categoria, c.categoria_padre_id,
              cp.nombre AS categoria_padre
       FROM imputaciones im
       JOIN factura_items fi ON fi.id = im.item_id
       JOIN facturas f ON f.id = fi.factura_id
       JOIN proveedores p ON p.id = f.proveedor_id
       LEFT JOIN categorias c ON c.id = im.categoria_id
       LEFT JOIN categorias cp ON cp.id = c.categoria_padre_id
       WHERE im.objeto_costo_id = ?
       ORDER BY f.fecha_emision DESC`
    )
    .bind(params.id)
    .all();

  const total = results.reduce((acc, r) => acc + r.monto_imputado, 0);

  // Agrupa por categoría (o "sin categoría"), sumando por moneda y por
  // unidad de medida por separado.
  const gruposPorCategoria = {};
  for (const r of results) {
    const clave = r.categoria_id ?? "sin_categoria";
    if (!gruposPorCategoria[clave]) {
      gruposPorCategoria[clave] = {
        categoria_id: r.categoria_id,
        categoria: r.categoria || "Sin categoría",
        categoria_padre: r.categoria_padre || null,
        por_moneda: {},
        por_unidad: {},
      };
    }
    const grupo = gruposPorCategoria[clave];

    const moneda = r.moneda || "PES";
    grupo.por_moneda[moneda] = (grupo.por_moneda[moneda] || 0) + r.monto_imputado;

    if (r.cantidad_imputada != null) {
      const unidad = r.unidad_medida || "unidad";
      grupo.por_unidad[unidad] = (grupo.por_unidad[unidad] || 0) + r.cantidad_imputada;
    }
  }

  return Response.json({
    movimientos: results,
    total,
    resumen_por_categoria: Object.values(gruposPorCategoria),
  });
}