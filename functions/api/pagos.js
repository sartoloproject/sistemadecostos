// POST /api/pagos
//   body: { factura_id, monto, fecha_pago, medio_pago?, referencia? }
// Registra un pago y lo aplica a una factura puntual. Recalcula el
// estado_pago de esa factura (pendiente / parcial / pagada) según cuánto
// se pagó en total hasta ahora.

export async function onRequestPost({ request, env }) {
  try {
    const { factura_id, monto, fecha_pago, medio_pago, referencia } = await request.json();

    if (!factura_id || !monto || monto <= 0) {
      return new Response("'factura_id' y 'monto' (mayor a 0) son requeridos", { status: 400 });
    }
    if (!fecha_pago) {
      return new Response("'fecha_pago' es requerida", { status: 400 });
    }

    const factura = await env.DB
      .prepare("SELECT proveedor_id, total FROM facturas WHERE id = ?")
      .bind(factura_id)
      .first();

    if (!factura) {
      return new Response("Factura no encontrada", { status: 404 });
    }

    const pago = await env.DB
      .prepare(
        `INSERT INTO pagos (proveedor_id, fecha_pago, monto, medio_pago, referencia)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      )
      .bind(factura.proveedor_id, fecha_pago, monto, medio_pago || null, referencia || null)
      .first();

    await env.DB
      .prepare(
        "INSERT INTO pago_factura (pago_id, factura_id, monto_aplicado) VALUES (?, ?, ?)"
      )
      .bind(pago.id, factura_id, monto)
      .run();

    const totalPagado = await env.DB
      .prepare(
        "SELECT COALESCE(SUM(monto_aplicado), 0) AS total FROM pago_factura WHERE factura_id = ?"
      )
      .bind(factura_id)
      .first();

    let nuevoEstado = "pendiente";
    if (totalPagado.total >= factura.total - 0.01) nuevoEstado = "pagada";
    else if (totalPagado.total > 0) nuevoEstado = "parcial";

    await env.DB
      .prepare("UPDATE facturas SET estado_pago = ? WHERE id = ?")
      .bind(nuevoEstado, factura_id)
      .run();

    return Response.json(
      {
        ok: true,
        pago_id: pago.id,
        nuevo_estado: nuevoEstado,
        total_pagado: totalPagado.total,
        saldo_restante: Math.max(0, factura.total - totalPagado.total),
      },
      { status: 201 }
    );
  } catch (error) {
    return new Response("Error registrando el pago: " + error.message, { status: 500 });
  }
}
