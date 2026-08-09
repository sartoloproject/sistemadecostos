// GET /api/resumen/:id/productos
// Agrupa TODOS los ítems comprados a un proveedor por descripción de
// producto, sumando: cantidad y monto total comprado, cuánto ya se
// imputó a objetos de costo, y cuánto queda disponible (todavía sin
// imputar). Separado por moneda, para no mezclar pesos con dólares.

export async function onRequestGet({ env, params }) {
  const { results } = await env.DB
    .prepare(
      `SELECT fi.id, fi.descripcion AS producto, fi.cantidad, fi.unidad_medida,
              fi.subtotal, fi.subtotal_con_iva, f.moneda,
              COALESCE((SELECT SUM(im.monto_imputado) FROM imputaciones im WHERE im.item_id = fi.id), 0) AS monto_imputado
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE f.proveedor_id = ?`
    )
    .bind(params.id)
    .all();

  const grupos = {};

  for (const r of results) {
    const baseTotal = r.subtotal_con_iva ?? r.subtotal;
    const moneda = r.moneda || "PES";
    const clave = `${r.producto}||${moneda}`;

    if (!grupos[clave]) {
      grupos[clave] = {
        producto: r.producto,
        unidad_medida: r.unidad_medida,
        moneda,
        cantidad_total: 0,
        monto_total: 0,
        monto_imputado: 0,
      };
    }

    grupos[clave].cantidad_total += r.cantidad;
    grupos[clave].monto_total += baseTotal;
    grupos[clave].monto_imputado += r.monto_imputado;
  }

  const productos = Object.values(grupos).map((g) => {
    const monto_disponible = Math.max(0, g.monto_total - g.monto_imputado);
    const cantidad_disponible_aprox =
      g.monto_total > 0 ? (g.cantidad_total * monto_disponible) / g.monto_total : g.cantidad_total;

    return {
      ...g,
      monto_disponible,
      cantidad_disponible_aprox: Math.round(cantidad_disponible_aprox * 10000) / 10000,
    };
  });

  return Response.json(productos);
}
