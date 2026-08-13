// GET /api/exportar/imputaciones?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Devuelve el detalle completo de imputaciones (qué se le imputó a cada
// objeto de costo, de qué producto, proveedor y categoría) — filtrando
// por la fecha en que se hizo la imputación.

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const desde = url.searchParams.get("desde");
  const hasta = url.searchParams.get("hasta");

  if (!desde || !hasta) {
    return new Response("Los parámetros 'desde' y 'hasta' son requeridos (YYYY-MM-DD)", { status: 400 });
  }

  const { results } = await env.DB
    .prepare(
      `SELECT im.creado_en AS fecha_imputacion, im.cantidad_imputada, im.porcentaje, im.monto_imputado,
              fi.descripcion AS producto, fi.unidad_medida,
              f.fecha_emision, f.moneda,
              p.razon_social AS proveedor,
              oc.tipo AS objeto_tipo, oc.nombre AS objeto_nombre,
              c.nombre AS categoria, cp.nombre AS categoria_padre
       FROM imputaciones im
       JOIN factura_items fi ON fi.id = im.item_id
       JOIN facturas f ON f.id = fi.factura_id
       JOIN proveedores p ON p.id = f.proveedor_id
       JOIN objetos_costo oc ON oc.id = im.objeto_costo_id
       LEFT JOIN categorias c ON c.id = im.categoria_id
       LEFT JOIN categorias cp ON cp.id = c.categoria_padre_id
       WHERE date(im.creado_en) BETWEEN ? AND ?
       ORDER BY im.creado_en`
    )
    .bind(desde, hasta)
    .all();

  return Response.json(results);
}
