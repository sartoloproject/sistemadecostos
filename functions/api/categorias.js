// GET  /api/categorias   -> lista todas las categorías, con el nombre de su padre si es subcategoría
// POST /api/categorias   -> crea una (o devuelve la existente si el nombre ya existe)
//      body: { nombre, categoria_padre_id? }

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare(
      `SELECT c.*, cp.nombre AS categoria_padre_nombre
       FROM categorias c
       LEFT JOIN categorias cp ON cp.id = c.categoria_padre_id
       ORDER BY COALESCE(cp.nombre, c.nombre), c.categoria_padre_id IS NULL DESC, c.nombre`
    )
    .all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  try {
    const { nombre, categoria_padre_id } = await request.json();

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
      .prepare("INSERT INTO categorias (nombre, categoria_padre_id) VALUES (?, ?) RETURNING *")
      .bind(nombreLimpio, categoria_padre_id || null)
      .first();

    return Response.json(nueva, { status: 201 });
  } catch (error) {
    return new Response("Error creando la categoría: " + error.message, { status: 500 });
  }
}