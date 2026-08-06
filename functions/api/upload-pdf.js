// POST /api/upload-pdf  (multipart/form-data, campo "archivo")
// Guarda el PDF en R2 y devuelve la key para asociarla a la factura.

export async function onRequestPost({ request, env }) {
  const formData = await request.formData();
  const archivo = formData.get("archivo");

  if (!archivo || typeof archivo === "string") {
    return new Response("Falta el archivo (campo 'archivo')", { status: 400 });
  }

  const key = `facturas/${Date.now()}-${archivo.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  await env.FACTURAS_BUCKET.put(key, await archivo.arrayBuffer(), {
    httpMetadata: { contentType: archivo.type || "application/pdf" },
  });

  return Response.json({ key });
}
