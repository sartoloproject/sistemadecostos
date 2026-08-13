// GET /api/exportar/iva-compras?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Devuelve, por factura (filtrando por fecha de EMISIÓN, como corresponde
// para el libro de IVA), el neto gravado, el IVA y el total — calculados
// sumando los ítems de cada factura.

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const desde = url.searchParams.get("desde");
  const hasta = url.searchParams.get("hasta");

  if (!desde || !hasta) {
    return new Response("Los parámetros 'desde' y 'hasta' son requeridos (YYYY-MM-DD)", { status: 400 });
  }

  const { results } = await env.DB
    .prepare(
      `SELECT f.id, f.tipo_cbte, f.punto_venta, f.numero, f.fecha_emision, f.moneda, f.cae,
              p.cuit, p.razon_social,
              SUM(fi.subtotal) AS neto,
              SUM(COALESCE(fi.subtotal_con_iva, fi.subtotal * (1 + fi.alicuota_iva / 100.0))) AS total_con_iva
       FROM facturas f
       JOIN proveedores p ON p.id = f.proveedor_id
       JOIN factura_items fi ON fi.factura_id = f.id
       WHERE f.fecha_emision BETWEEN ? AND ?
       GROUP BY f.id
       ORDER BY f.fecha_emision, f.id`
    )
    .bind(desde, hasta)
    .all();

  const filas = results.map((r) => ({
    ...r,
    iva: r.total_con_iva - r.neto,
  }));

  return Response.json(filas);
}
