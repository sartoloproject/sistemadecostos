// DELETE /api/pagos/:id -> elimina el pago (y su aplicación a la factura),
// recalculando el estado_pago de la factura afectada.

export async function onRequestDelete({ env, params }) {
  try {
    const aplicaciones = await env.DB
      .prepare("SELECT factura_id FROM pago_factura WHERE pago_id = ?")
      .bind(params.id)
      .all();

    if (aplicaciones.results.length === 0) {
      return new Response("Pago no encontrado", { status: 404 });
    }

    await env.DB.prepare("DELETE FROM pagos WHERE id = ?").bind(params.id).run(); // cascada borra pago_factura

    for (const { factura_id } of aplicaciones.results) {
      const factura = await env.DB
        .prepare("SELECT total FROM facturas WHERE id = ?")
        .bind(factura_id)
        .first();
      if (!factura) continue;

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
    }

    return Response.json({ ok: true });
  } catch (error) {
    return new Response("Error eliminando el pago: " + error.message, { status: 500 });
  }
}
