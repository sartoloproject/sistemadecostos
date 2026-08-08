// GET  /api/categorias   -> lista todas las categorías
// POST /api/categorias   -> crea una (o devuelve la existente si el nombre ya existe)
//      body: { nombre }

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare("SELECT * FROM categorias ORDER BY nombre")
    .all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  try {
    const { nombre } = await request.json();

    if (!nombre || !nombre.trim()) {
      return new Response("El campo 'nombre' es requerido", { status: 400 });
    }

    const nombreLimpio = nombre.trim();

    const existente = await env.DB
      .prepare("SELECT * FROM categorias WHERE nombre = ?")
      .bind(nombreLimpio)
      .first();

    if (existente) {
      return Response.json(existente);
    }

    const nueva = await env.DB
      .prepare("INSERT INTO categorias (nombre) VALUES (?) RETURNING *")
      .bind(nombreLimpio)
      .first();

    return Response.json(nueva, { status: 201 });
  } catch (error) {
    return new Response("Error creando la categoría: " + error.message, { status: 500 });
  }
}
