// GET  /api/facturas?proveedor_id=123   -> lista facturas (opcionalmente filtradas)
// POST /api/facturas                     -> crea una factura + sus ítems
//      body: {
//        qr: { cuit, tipoCmp, ptoVta, nroCmp, fecha, importe, moneda, codAut },
//        items: [{ descripcion, cantidad, unidad_medida, precio_unitario, alicuota_iva, subtotal }],
//        archivo_key: "facturas/....pdf"   (opcional, viene de /api/upload-pdf)
//      }

const TIPO_CBTE_AFIP = {
  1: "001", 2: "002", 3: "003",
  6: "006", 7: "007", 8: "008",
  11: "011", 12: "012", 13: "013",
};

function formatearFechaAfip(fecha) {
  // AFIP entrega 'YYYYMMDD' -> la pasamos a 'YYYY-MM-DD'
  if (!fecha || String(fecha).length !== 8) return fecha;
  const f = String(fecha);
  return `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const proveedorId = url.searchParams.get("proveedor_id");

  const stmt = proveedorId
    ? env.DB.prepare(
        "SELECT * FROM facturas WHERE proveedor_id = ? ORDER BY fecha_emision DESC"
      ).bind(proveedorId)
    : env.DB.prepare("SELECT * FROM facturas ORDER BY fecha_emision DESC");

  const { results } = await stmt.all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { qr, items, archivo_key } = body;

    if (!qr || !qr.cuit) {
      return new Response(
        "Falta el payload del QR de AFIP (no se pudo leer del PDF)",
        { status: 400 }
      );
    }

    const cuit = String(qr.cuit);

    // 1. Resolver o crear proveedor
    let proveedor = await env.DB
      .prepare("SELECT id FROM proveedores WHERE cuit = ?")
      .bind(cuit)
      .first();

    if (!proveedor) {
      proveedor = await env.DB
        .prepare(
          "INSERT INTO proveedores (cuit, razon_social, condicion_iva) VALUES (?, ?, ?) RETURNING id"
        )
        .bind(cuit, `PENDIENTE COMPLETAR (${cuit})`, "Sin definir")
        .first();
    }
    const proveedorId = proveedor.id;

    // 2. Insertar factura
    const tipoCbte = TIPO_CBTE_AFIP[qr.tipoCmp] || String(qr.tipoCmp);
    let factura;
    try {
      factura = await env.DB
        .prepare(
          `INSERT INTO facturas (proveedor_id, tipo_cbte, punto_venta, numero, fecha_emision,
                                  cae, moneda, tipo_cambio, total, origen_extraccion, archivo_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .bind(
          proveedorId,
          tipoCbte,
          String(qr.ptoVta),
          String(qr.nroCmp),
          formatearFechaAfip(qr.fecha),
          qr.codAut || null,
          qr.moneda || "PES",
          qr.ctz || null,
          qr.importe || 0,
          items && items.length ? "qr" : "qr_items_pendientes",
          archivo_key || null
        )
        .first();
    } catch (e) {
      // solo es "ya estaba cargada" si el error es específicamente por la
      // restricción UNIQUE (proveedor+tipo+punto de venta+número); para
      // cualquier otro error, mostramos el motivo real en vez de ocultarlo
      const esDuplicado = /UNIQUE constraint failed/i.test(e.message);
      if (esDuplicado) {
        return new Response(
          "Esta factura ya estaba cargada (mismo proveedor, tipo, punto de venta y número).",
          { status: 409 }
        );
      }
      return new Response("Error insertando la factura: " + e.message, { status: 500 });
    }

    // 3. Insertar ítems
    for (const item of items || []) {
      await env.DB
        .prepare(
          `INSERT INTO factura_items (factura_id, descripcion, cantidad, unidad_medida,
                                       precio_unitario, alicuota_iva, subtotal, subtotal_con_iva)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          factura.id,
          item.descripcion,
          item.cantidad,
          item.unidad_medida,
          item.precio_unitario,
          item.alicuota_iva,
          item.subtotal,
          item.subtotal_con_iva ?? null
        )
        .run();
    }

    return Response.json(
      {
        factura_id: factura.id,
        proveedor_id: proveedorId,
        items_cargados: (items || []).length,
      },
      { status: 201 }
    );
  } catch (error) {
    // Devuelve el motivo real del error en vez de la página genérica de Cloudflare.
    // Causa más común: la base de datos no tiene alguna columna que el código
    // espera (falta correr una migración pendiente en schema/).
    return new Response(
      "Error interno guardando la factura: " + error.message,
      { status: 500 }
    );
  }
}