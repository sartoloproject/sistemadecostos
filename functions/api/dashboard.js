// GET /api/dashboard
// Junta los datos para la pantalla de inicio:
//   - gasto del mes actual (por fecha de imputación), por categoría y por moneda
//   - proveedores con saldo pendiente, por moneda
//   - cantidad y monto de ítems todavía sin imputar

export async function onRequestGet({ env }) {
  const ahora = new Date();
  const mesActual = `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`;

  // --- gasto del mes por categoría (y por moneda) ---
  const gastoPorCategoria = await env.DB
    .prepare(
      `SELECT c.id AS categoria_id, c.nombre AS categoria, cp.nombre AS categoria_padre,
              f.moneda, SUM(im.monto_imputado) AS monto
       FROM imputaciones im
       JOIN factura_items fi ON fi.id = im.item_id
       JOIN facturas f ON f.id = fi.factura_id
       LEFT JOIN categorias c ON c.id = im.categoria_id
       LEFT JOIN categorias cp ON cp.id = c.categoria_padre_id
       WHERE strftime('%Y-%m', im.creado_en) = ?
       GROUP BY im.categoria_id, f.moneda
       ORDER BY monto DESC`
    )
    .bind(mesActual)
    .all();

  // --- gasto total del mes, por moneda ---
  const gastoTotalPorMoneda = await env.DB
    .prepare(
      `SELECT f.moneda, SUM(im.monto_imputado) AS monto
       FROM imputaciones im
       JOIN factura_items fi ON fi.id = im.item_id
       JOIN facturas f ON f.id = fi.factura_id
       WHERE strftime('%Y-%m', im.creado_en) = ?
       GROUP BY f.moneda`
    )
    .bind(mesActual)
    .all();

  // --- saldo pendiente por proveedor y moneda (para todos, filtramos > 0 después) ---
  const saldosCrudos = await env.DB
    .prepare(
      `SELECT p.id AS proveedor_id, p.razon_social, f.moneda,
              SUM(f.total) AS total_facturado,
              COALESCE((
                SELECT SUM(pf.monto_aplicado) FROM pago_factura pf
                JOIN facturas f2 ON f2.id = pf.factura_id
                WHERE f2.proveedor_id = p.id AND f2.moneda = f.moneda
              ), 0) AS total_pagado
       FROM proveedores p
       JOIN facturas f ON f.proveedor_id = p.id
       GROUP BY p.id, f.moneda`
    )
    .all();

  const proveedoresPendientes = saldosCrudos.results
    .map((s) => ({
      proveedor_id: s.proveedor_id,
      razon_social: s.razon_social,
      moneda: s.moneda || "PES",
      saldo_pendiente: s.total_facturado - s.total_pagado,
    }))
    .filter((s) => s.saldo_pendiente > 0.01)
    .sort((a, b) => b.saldo_pendiente - a.saldo_pendiente)
    .slice(0, 10);

  // --- ítems pendientes de imputar: cantidad y monto restante por moneda ---
  const itemsPendientes = await env.DB
    .prepare(
      `SELECT fi.subtotal, fi.subtotal_con_iva, f.moneda,
              COALESCE((SELECT SUM(im.monto_imputado) FROM imputaciones im WHERE im.item_id = fi.id), 0) AS monto_imputado
       FROM factura_items fi
       JOIN facturas f ON f.id = fi.factura_id
       WHERE fi.imputado_completo = 0`
    )
    .all();

  const restantePorMoneda = {};
  for (const r of itemsPendientes.results) {
    const baseTotal = r.subtotal_con_iva ?? r.subtotal;
    const restante = Math.max(0, baseTotal - r.monto_imputado);
    const moneda = r.moneda || "PES";
    restantePorMoneda[moneda] = (restantePorMoneda[moneda] || 0) + restante;
  }

  return Response.json({
    mes: mesActual,
    gasto_mes_por_categoria: gastoPorCategoria.results,
    gasto_mes_total_por_moneda: gastoTotalPorMoneda.results,
    proveedores_pendientes: proveedoresPendientes,
    pendientes_imputar: {
      cantidad_items: itemsPendientes.results.length,
      restante_por_moneda: Object.entries(restantePorMoneda).map(([moneda, monto]) => ({ moneda, monto })),
    },
  });
}
