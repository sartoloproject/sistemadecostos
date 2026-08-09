// POST /api/extraer-items-ia
//   body: { texto, importe_total_qr, moneda, imagen_base64? }
//
// Se usa como respaldo automático cuando el detector rápido (heurística
// local, gratis) no logra que la suma de los ítems coincida con el
// importe total real de la factura (que viene del QR de AFIP, siempre
// confiable). Usa Gemini (tier gratuito de Google AI Studio).
//
// Si además se manda "imagen_base64" (la primera página del PDF
// renderizada), Gemini puede leerla directamente como una imagen — esto
// es necesario para PDFs que no tienen texto real (algunos sistemas de
// facturación "dibujan" todo como imágenes en vez de texto seleccionable).

export async function onRequestPost({ request, env }) {
  try {
    const { texto, importe_total_qr, moneda, imagen_base64 } = await request.json();

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        "No hay GEMINI_API_KEY configurada en Cloudflare Pages (Settings > Environment variables). " +
          "Sin eso, no se puede usar la extracción por IA como respaldo.",
        { status: 500 }
      );
    }

    const hayTextoUtil = texto && texto.replace(/\s/g, "").length > 20;

    const prompt = `Sos un asistente que extrae la tabla de ítems (productos o servicios) de una factura argentina.

${
  hayTextoUtil
    ? "Tenés el texto ya extraído del PDF más abajo."
    : "El PDF no tiene texto seleccionable (está compuesto por imágenes), así que se te adjunta una imagen de la factura — leé el texto directamente de la imagen, como si fuera OCR."
}

Identificá cada ítem facturado y devolvé SOLO un JSON (sin texto adicional, sin bloques de código markdown) con esta forma exacta:

{
  "items": [
    {"descripcion": "...", "cantidad": 0, "unidad_medida": "...", "precio_unitario": 0, "alicuota_iva": 21, "subtotal": 0, "subtotal_con_iva": 0}
  ]
}

Reglas:
- "subtotal" es el importe SIN IVA (neto) de esa línea.
- "subtotal_con_iva" es el importe CON IVA de esa línea. Si la factura no lo muestra separado por ítem, calculalo: subtotal * (1 + alicuota_iva/100).
- Si la factura no discrimina alícuota de IVA por ítem, sino que aplica una única alícuota global (mostrada al pie de la factura), usá esa misma alícuota en "alicuota_iva" para todos los ítems.
- "cantidad" y "precio_unitario" son números (no texto). Usá punto como separador decimal, nunca coma.
- Si una línea de ítem no muestra cantidad explícita, asumí 1.
- Ignorá por completo los párrafos de texto legal, condiciones de pago, datos de cliente o proveedor, vencimientos, y cualquier texto que no sea una línea de producto o servicio facturado.
- El importe total real de esta factura es ${importe_total_qr} ${moneda || ""}. Usalo como referencia para verificar tu propia extracción antes de responder — la suma de "subtotal_con_iva" de todos los ítems tiene que dar ese número.
${hayTextoUtil ? `\nTexto de la factura:\n---\n${texto}\n---` : ""}`;

    const parts = [{ text: prompt }];
    if (imagen_base64) {
      parts.push({ inline_data: { mime_type: "image/png", data: imagen_base64 } });
    }

    const respuestaIA = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    if (!respuestaIA.ok) {
      const errorTexto = await respuestaIA.text();
      return new Response("Error llamando a la IA: " + errorTexto, { status: 502 });
    }

    const data = await respuestaIA.json();
    let textoResp = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    textoResp = textoResp
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");

    let parseado;
    try {
      parseado = JSON.parse(textoResp);
    } catch (e) {
      return new Response(
        "La IA no devolvió un JSON válido. Respuesta cruda: " + textoResp.slice(0, 400),
        { status: 502 }
      );
    }

    const items = parseado.items || [];
    const sumaDetectada = items.reduce((acc, it) => {
      const conIva = it.subtotal_con_iva ?? it.subtotal * (1 + (it.alicuota_iva || 0) / 100);
      return acc + (conIva || 0);
    }, 0);

    const total = importe_total_qr || 0;
    const diferencia = Math.abs(sumaDetectada - total);
    const coincide = total > 0 ? diferencia / total < 0.02 : true; // tolerancia 2%

    return Response.json({
      items,
      suma_detectada: sumaDetectada,
      total_factura: total,
      diferencia,
      coincide,
    });
  } catch (error) {
    return new Response("Error interno en extracción por IA: " + error.message, { status: 500 });
  }
}