// GET /api/items/pendientes
// Junta, de TODAS las facturas, los ítems que todavía no están 100%
// asignados a un objeto de costo. Sirve como "bandeja de pendientes"
// para no tener que ir factura por factura buscando qué falta imputar.

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare(
      `SELECT fi.id, fi.descripcion AS producto, fi.cantidad, fi.unidad_medida,
              fi.subtotal, fi.subtotal_con_iva, fi.factura_id,
              f.fecha_emision, f.numero, f.punto_venta, f.moneda,
              p.razon_social AS proveedor,
              COALESCE((SELECT SUM(im.monto_imputado) FROM imputaciones im WHERE im.item_id = fi.id), 0) AS monto_ya_imputado
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       JOIN proveedores p ON p.id = f.proveedor_id
       WHERE fi.imputado_completo = 0
       ORDER BY f.fecha_emision DESC`
    )
    .all();

  const pendientes = results.map((r) => {
    const baseTotal = r.subtotal_con_iva ?? r.subtotal;
    const restante = Math.max(0, baseTotal - r.monto_ya_imputado);
    // cantidad física aproximada que falta imputar, proporcional al monto restante
    const cantidadRestanteAprox = baseTotal > 0 ? (r.cantidad * restante) / baseTotal : r.cantidad;

    return {
      ...r,
      base_total: baseTotal,
      restante,
      cantidad_restante_aprox: Math.round(cantidadRestanteAprox * 10000) / 10000,
    };
  });

  return Response.json(pendientes);
}
