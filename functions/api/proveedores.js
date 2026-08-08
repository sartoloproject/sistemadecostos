// GET  /api/proveedores            -> lista todos los proveedores
// GET  /api/proveedores?q=texto    -> busca por CUIT o razón social (parcial)
// POST /api/proveedores            -> crea uno (o devuelve el existente por CUIT)

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  const stmt = q
    ? env.DB
        .prepare(
          "SELECT * FROM proveedores WHERE cuit LIKE ? OR razon_social LIKE ? ORDER BY razon_social LIMIT 20"
        )
        .bind(`%${q}%`, `%${q}%`)
    : env.DB.prepare("SELECT * FROM proveedores ORDER BY razon_social");

  const { results } = await stmt.all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { cuit, razon_social, condicion_iva, email, telefono, direccion, rubro } = body;

  if (!cuit) {
    return new Response("El campo 'cuit' es requerido", { status: 400 });
  }

  const existente = await env.DB
    .prepare("SELECT * FROM proveedores WHERE cuit = ?")
    .bind(cuit)
    .first();

  if (existente) {
    return Response.json(existente);
  }

  const nuevo = await env.DB
    .prepare(
      `INSERT INTO proveedores (cuit, razon_social, condicion_iva, email, telefono, direccion, rubro)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(
      cuit,
      razon_social || `PENDIENTE COMPLETAR (${cuit})`,
      condicion_iva || "Sin definir",
      email || null,
      telefono || null,
      direccion || null,
      rubro || null
    )
    .first();

  return Response.json(nuevo, { status: 201 });
}