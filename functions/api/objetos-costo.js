// GET  /api/objetos-costo   -> lista objetos de costo activos
// POST /api/objetos-costo   -> crea uno nuevo
//      body: { tipo: "maquinaria"|"vehiculo"|"lote"|"gasto_general", nombre, identificador? }

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare("SELECT * FROM objetos_costo WHERE activo = 1 ORDER BY tipo, nombre")
    .all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const { tipo, nombre, identificador } = await request.json();

  if (!tipo || !nombre) {
    return new Response("Los campos 'tipo' y 'nombre' son requeridos", { status: 400 });
  }

  const nuevo = await env.DB
    .prepare(
      "INSERT INTO objetos_costo (tipo, nombre, identificador) VALUES (?, ?, ?) RETURNING *"
    )
    .bind(tipo, nombre, identificador || null)
    .first();

  return Response.json(nuevo, { status: 201 });
}
