// ============================================================
// NAVEGACIÓN ENTRE PESTAÑAS
// ============================================================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ============================================================
// TAB: CARGAR FACTURA
// ============================================================
let archivoPdfActual = null;
let qrDetectado = null;

document.getElementById("input-pdf").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;

  archivoPdfActual = archivo;
  const estado = document.getElementById("estado-parseo");
  estado.textContent = "Leyendo el PDF...";
  document.getElementById("bloque-cabecera").style.display = "none";
  document.getElementById("resultado-guardado").textContent = ""; // limpia confirmación de una carga anterior

  try {
    const arrayBuffer = await archivo.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let textoCompleto = "";
    qrDetectado = null;
    let primeraPaginaImagenBase64 = null;

    for (let numPagina = 1; numPagina <= pdf.numPages; numPagina++) {
      const pagina = await pdf.getPage(numPagina);

      // --- texto de la página (reconstruyendo líneas por posición) ---
      const contenidoTexto = await pagina.getTextContent();
      const lineasPagina = reconstruirLineas(contenidoTexto.items);
      textoCompleto += lineasPagina.join("\n") + "\n";

      // --- buscar QR renderizando la página a un canvas ---
      if (!qrDetectado) {
        const viewport = pagina.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await pagina.render({ canvasContext: ctx, viewport }).promise;

        // guardamos la imagen de la primera página por si el PDF no tiene
        // texto real (algunos sistemas de facturación "dibujan" todo como
        // imagen) y hay que mandársela a la IA en vez de texto
        if (!primeraPaginaImagenBase64) {
          primeraPaginaImagenBase64 = canvas.toDataURL("image/png").split(",")[1];
        }

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const resultado = jsQR(imageData.data, imageData.width, imageData.height);

        if (resultado) {
          qrDetectado = decodificarQrAfip(resultado.data);
        }
      }
    }

    let importeReferencia = qrDetectado?.importe || null;

    if (qrDetectado) {
      estado.textContent = "QR de AFIP detectado. Revisá los datos antes de guardar.";
      completarCabeceraDesdeQr(qrDetectado);
    } else {
      importeReferencia = extraerTotalDesdeTexto(textoCompleto);
      estado.textContent = importeReferencia
        ? "No se pudo leer el QR de AFIP en este PDF, pero se detectó el importe total en el texto. Completá el resto a mano."
        : "No se pudo leer el QR de AFIP en este PDF. Completá los datos de cabecera a mano.";
      completarCabeceraDesdeQr({ importe: importeReferencia });
    }

    document.getElementById("bloque-cabecera").style.display = "block";

    let itemsDetectados = intentarDetectarItems(textoCompleto);
    const resultadoValidacion = validarSumaItems(itemsDetectados, importeReferencia);

    if (!resultadoValidacion.coincide) {
      estado.textContent = "Los ítems no coinciden con el total de la factura — probando con IA...";
      try {
        const respuestaIA = await fetch("/api/extraer-items-ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            texto: textoCompleto,
            importe_total_qr: importeReferencia || null,
            moneda: qrDetectado?.moneda || "PES",
            imagen_base64: primeraPaginaImagenBase64,
          }),
        });

        if (respuestaIA.ok) {
          const dataIA = await respuestaIA.json();
          itemsDetectados = dataIA.items;
          estado.textContent = dataIA.coincide
            ? "Ítems detectados con IA (formato nuevo para este proveedor) y el total coincide. Revisalos igual antes de guardar."
            : `⚠ Ni la IA logró que sume el total exacto (detectado $${dataIA.suma_detectada.toFixed(2)} vs factura $${dataIA.total_factura.toFixed(2)}). Revisá y corregí a mano.`;
        } else {
          const errorTexto = await respuestaIA.text();
          estado.textContent = `No se detectaron ítems automáticamente y la IA falló (${errorTexto}). Cargalos a mano.`;
          itemsDetectados = [];
        }
      } catch (errIA) {
        estado.textContent = "No se pudo contactar el respaldo de IA. Cargá los ítems a mano.";
        itemsDetectados = [];
      }
    } else if (itemsDetectados.length > 0) {
      estado.textContent += " Ítems detectados automáticamente y el total coincide con la factura.";
    }

    renderizarItems(itemsDetectados);
  } catch (err) {
    console.error(err);
    estado.textContent = "Error leyendo el PDF: " + err.message;
  }
});

// pdf.js devuelve cada fragmento de texto con su posición (transform[5] = coordenada Y).
// Sin esto, todo el texto de la página queda como una sola línea gigante y el detector
// de ítems no puede distinguir la fila de la tabla del resto de la factura.
function reconstruirLineas(items) {
  const ordenados = [...items].sort(
    (a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]
  );

  const TOLERANCIA_Y = 2; // px de margen para considerar que dos fragmentos están en la misma línea
  const lineas = [];
  let lineaActual = [];
  let yActual = null;

  for (const item of ordenados) {
    const y = item.transform[5];
    if (yActual === null || Math.abs(y - yActual) <= TOLERANCIA_Y) {
      lineaActual.push(item);
      if (yActual === null) yActual = y;
    } else {
      lineas.push(lineaActual);
      lineaActual = [item];
      yActual = y;
    }
  }
  if (lineaActual.length) lineas.push(lineaActual);

  return lineas.map((linea) =>
    linea
      .sort((a, b) => a.transform[4] - b.transform[4])
      .map((it) => it.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Las descripciones de producto en facturas AR suelen ir en mayúsculas;
// los párrafos de texto legal (pie de página) son oraciones normales -> se descartan.
function esMayoritariamenteMayusculas(texto) {
  const letras = texto.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letras.length < 3) return false;
  const mayusculas = letras.replace(/[^A-ZÀ-Ý]/g, "");
  return mayusculas.length / letras.length > 0.6;
}

// Mapea los números encontrados en la línea a los campos del ítem.
// Formatos comunes en facturas AR:
//   3 números -> cantidad, precio_unitario, subtotal
//   5 números -> cantidad, precio_unitario, subtotal, % IVA, subtotal c/IVA
const TASAS_IVA_COMUNES = [0, 2.5, 5, 10.5, 21, 27];

function mapearColumnasItem(nums) {
  if (nums.length >= 5) {
    const posibleAlicuota = Math.round(nums[nums.length - 2] * 10) / 10;
    if (TASAS_IVA_COMUNES.includes(posibleAlicuota)) {
      return {
        cantidad: nums[0],
        precio_unitario: nums[1],
        subtotal: nums[2],
        alicuota_iva: posibleAlicuota,
        subtotal_con_iva: nums[4],
      };
    }
  }

  // fallback genérico: últimos dos números = precio y subtotal, primero = cantidad
  return {
    cantidad: nums[0],
    precio_unitario: nums[nums.length - 2],
    subtotal: nums[nums.length - 1],
    alicuota_iva: 21,
    subtotal_con_iva: null,
  };
}

// Decide si los últimos números de la línea forman un bloque de 3 columnas
// (cantidad, precio, subtotal) o de 5 (cantidad, precio, subtotal, % IVA,
// subtotal c/IVA), mirando si el anteúltimo valor es una alícuota típica.
function elegirCantidadColumnas(coincidencias, convertidor) {
  if (coincidencias.length >= 5) {
    const posibleAlicuota = Math.round(convertidor(coincidencias[coincidencias.length - 2][0]) * 10) / 10;
    if (TASAS_IVA_COMUNES.includes(posibleAlicuota)) return 5;
  }
  return 3;
}

// La palabra de la unidad (Kilos, Litros, Unidades, etc.) casi siempre
// aparece pegada entre el número de cantidad y el de precio unitario:
// "... 40.00 Litros 5.5000 ...". La extraemos de esa posición en vez de
// asumir "unidad" siempre.
function extraerUnidadMedida(linea, coincidencias, cantColumnas) {
  const idxBase = coincidencias.length - cantColumnas;
  const matchCantidad = coincidencias[idxBase];
  const matchPrecio = coincidencias[idxBase + 1];
  if (!matchCantidad || !matchPrecio) return null;

  const entre = linea.slice(matchCantidad.index + matchCantidad[0].length, matchPrecio.index).trim();

  // tiene que ser una palabra razonable: solo letras, sin números ni símbolos raros
  if (entre && entre.length <= 20 && /^[a-zA-ZÀ-ÿ.]+$/.test(entre)) {
    return entre;
  }
  return null;
}

// Compara lo que detectó el parser local contra el importe real de la
// factura (del QR, siempre confiable). Si no coincide, es señal de que
// el formato de este proveedor rompió al detector automático.
// Cuando no hay QR (facturas viejas, controladores fiscales, etc.) busca
// el total impreso en el texto como referencia para validar, buscando
// líneas tipo "Total 816815.00" o "Importe Total: $ 1124238.29".
function extraerTotalDesdeTexto(texto) {
  const regexTotal = /(total\s*general|importe\s*total|^\s*total\b)[^\d-]*(-?[\d.,]+)\s*$/im;
  const lineas = texto.split("\n");
  let ultimoEncontrado = null;

  for (const linea of lineas) {
    const m = linea.match(regexTotal);
    if (m) ultimoEncontrado = aNumero(m[2]);
  }

  return ultimoEncontrado;
}

function validarSumaItems(items, importeTotalQr) {
  if (!importeTotalQr) {
    // sin QR no hay nada confiable contra qué comparar -> mejor no confiar
    // a ciegas en la heurística local, pedimos el respaldo de IA
    return { coincide: false, suma: 0 };
  }
  if (items.length === 0) {
    return { coincide: false, suma: 0 };
  }

  const suma = items.reduce((acc, it) => acc + (it.subtotal_con_iva || it.subtotal || 0), 0);
  const diferencia = Math.abs(suma - importeTotalQr);
  const coincide = diferencia / importeTotalQr < 0.02; // tolerancia 2%

  return { coincide, suma };
}

function decodificarQrAfip(contenidoQr) {
  try {
    const url = new URL(contenidoQr);
    const p = url.searchParams.get("p");
    if (!p) return null;
    const json = decodeURIComponent(escape(atob(p)));
    return JSON.parse(json);
  } catch (err) {
    console.warn("No se pudo decodificar el QR como formato AFIP:", err);
    return null;
  }
}

function formatearFechaAfip(fecha) {
  if (!fecha || String(fecha).length !== 8) return fecha || "";
  const f = String(fecha);
  return `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
}

const TIPO_CBTE_AFIP = {
  1: "001", 2: "002", 3: "003",
  6: "006", 7: "007", 8: "008",
  11: "011", 12: "012", 13: "013",
};

function completarCabeceraDesdeQr(qr) {
  document.getElementById("f-cuit").value = qr.cuit || "";
  document.getElementById("f-tipo").value = TIPO_CBTE_AFIP[qr.tipoCmp] || qr.tipoCmp || "";
  document.getElementById("f-ptovta").value = qr.ptoVta || "";
  document.getElementById("f-numero").value = qr.nroCmp || "";
  document.getElementById("f-fecha").value = formatearFechaAfip(qr.fecha);
  document.getElementById("f-total").value = qr.importe || "";
  document.getElementById("f-cae").value = qr.codAut || "";
  document.getElementById("f-moneda").value = qr.moneda || "PES";
  document.getElementById("f-tc").value = qr.ctz || "";
}

// --- detección "mejor esfuerzo" de ítems a partir del texto plano ---
// Busca líneas con al menos 3 números (cantidad, precio, subtotal).
// Es un punto de partida: el usuario revisa y corrige en la tabla.
function intentarDetectarItems(texto) {
  const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = [];

  const regexNumero = /-?\d+(?:[.,]\d+)*/g;
  const PALABRAS_EXCLUIDAS = /cuit|fecha|domicilio|numero|número|cond\.|ing\. bruto|inic\. act|pedido|neto grava|exento|vencimiento|c\.u\.i\.t|efectos fiscales|derechos emergentes|dispuesto en|art[íi]culo|modificatoria|tipo de cambio|lugar de pago/i;

  for (const linea of lineas) {
    // las líneas de datos de cabecera son del tipo "Campo: valor" -> se descartan
    if (linea.includes(":")) continue;
    if (PALABRAS_EXCLUIDAS.test(linea)) continue;
    // (los párrafos de texto legal se filtran más abajo por estar en minúsculas,
    // no por longitud — nombres de productos como herbicidas pueden ser largos)

    // Se buscan los números anclados al FINAL de la línea, no al primero que
    // aparezca: la descripción del producto puede tener números propios
    // (ej. "CEBADA NEGRA X 40 KG"), y si cortáramos ahí perderíamos la
    // columna real de cantidad/precio/subtotal.
    const coincidencias = [...linea.matchAll(new RegExp(regexNumero, "g"))];
    if (coincidencias.length < 3) continue;

    const cantColumnas = elegirCantidadColumnas(coincidencias, aNumero);
    const primeraColumnaUsada = coincidencias[coincidencias.length - cantColumnas];
    const descripcion = linea.slice(0, primeraColumnaUsada.index).trim();
    if (descripcion.length < 3) continue;
    if (!esMayoritariamenteMayusculas(descripcion)) continue;

    const nums = coincidencias.slice(coincidencias.length - cantColumnas).map((m) => aNumero(m[0]));
    const { cantidad, precio_unitario, subtotal, alicuota_iva, subtotal_con_iva } = mapearColumnasItem(nums);
    const unidadDetectada = extraerUnidadMedida(linea, coincidencias, cantColumnas);

    items.push({
      descripcion,
      cantidad: cantidad || 1,
      unidad_medida: unidadDetectada || "unidad",
      precio_unitario: precio_unitario || 0,
      alicuota_iva: alicuota_iva,
      subtotal: subtotal || 0,
      subtotal_con_iva: subtotal_con_iva || null,
    });
  }

  return items;
}

function aNumero(s) {
  if (!s) return 0;
  let limpio = s.replace(/\s/g, "");

  const cantidadSeparadores = (limpio.match(/[.,]/g) || []).length;

  if (cantidadSeparadores > 1) {
    // más de un separador: el último es el decimal, el resto son de miles
    const posUltimo = Math.max(limpio.lastIndexOf("."), limpio.lastIndexOf(","));
    const enteros = limpio.slice(0, posUltimo).replace(/[.,]/g, "");
    const decimales = limpio.slice(posUltimo + 1);
    limpio = `${enteros}.${decimales}`;
  } else {
    // un solo separador (o ninguno): se interpreta directamente como decimal
    limpio = limpio.replace(",", ".");
  }

  const n = parseFloat(limpio);
  return isNaN(n) ? 0 : n;
}

// --- tabla editable de ítems ---
function renderizarItems(items) {
  const tbody = document.querySelector("#tabla-items tbody");
  tbody.innerHTML = "";
  items.forEach((item) => agregarFilaItem(item));
  if (items.length === 0) agregarFilaItem();
}

function agregarFilaItem(item = {}) {
  const tbody = document.querySelector("#tabla-items tbody");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="c-descripcion" type="text" value="${item.descripcion || ""}"></td>
    <td><input class="c-cantidad" type="number" step="0.0001" value="${item.cantidad ?? ""}"></td>
    <td><input class="c-unidad" type="text" value="${item.unidad_medida || "unidad"}"></td>
    <td><input class="c-precio" type="number" step="0.0001" value="${item.precio_unitario ?? ""}"></td>
    <td><input class="c-iva" type="number" step="0.01" value="${item.alicuota_iva ?? 21}"></td>
    <td><input class="c-subtotal" type="number" step="0.01" value="${item.subtotal ?? ""}"></td>
    <td><input class="c-subtotal-con-iva" type="number" step="0.01" value="${item.subtotal_con_iva ?? ""}"></td>
    <td><button type="button" class="btn-quitar">✕</button></td>
  `;
  tr.querySelector(".btn-quitar").addEventListener("click", () => tr.remove());
  tbody.appendChild(tr);
}

document.getElementById("btn-agregar-item").addEventListener("click", () => agregarFilaItem());

function leerItemsDeTabla() {
  const filas = document.querySelectorAll("#tabla-items tbody tr");
  return Array.from(filas)
    .map((tr) => ({
      descripcion: tr.querySelector(".c-descripcion").value.trim(),
      cantidad: parseFloat(tr.querySelector(".c-cantidad").value) || 0,
      unidad_medida: tr.querySelector(".c-unidad").value.trim() || "unidad",
      precio_unitario: parseFloat(tr.querySelector(".c-precio").value) || 0,
      alicuota_iva: parseFloat(tr.querySelector(".c-iva").value) || 0,
      subtotal: parseFloat(tr.querySelector(".c-subtotal").value) || 0,
      subtotal_con_iva: parseFloat(tr.querySelector(".c-subtotal-con-iva").value) || null,
    }))
    .filter((it) => it.descripcion);
}

document.getElementById("btn-guardar-factura").addEventListener("click", async () => {
  const resultadoDiv = document.getElementById("resultado-guardado");
  resultadoDiv.textContent = "Guardando...";

  try {
    let archivoKey = null;
    if (archivoPdfActual) {
      const formData = new FormData();
      formData.append("archivo", archivoPdfActual);
      const respSubida = await fetch("/api/upload-pdf", { method: "POST", body: formData });
      if (respSubida.ok) {
        archivoKey = (await respSubida.json()).key;
      }
    }

    const qr = {
      cuit: document.getElementById("f-cuit").value.trim(),
      tipoCmp: document.getElementById("f-tipo").value.trim(),
      ptoVta: document.getElementById("f-ptovta").value.trim(),
      nroCmp: document.getElementById("f-numero").value.trim(),
      fecha: document.getElementById("f-fecha").value.trim(),
      importe: parseFloat(document.getElementById("f-total").value) || 0,
      codAut: document.getElementById("f-cae").value.trim(),
      moneda: document.getElementById("f-moneda").value.trim() || "PES",
      ctz: parseFloat(document.getElementById("f-tc").value) || null,
    };
    // el backend mapea tipoCmp numérico -> código AFIP; si ya viene como
    // código de 3 dígitos (por edición manual) lo dejamos pasar igual
    if (/^\d{3}$/.test(qr.tipoCmp)) {
      qr.tipoCmp = parseInt(qr.tipoCmp, 10);
    }

    const items = leerItemsDeTabla();

    const resp = await fetch("/api/facturas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qr, items, archivo_key: archivoKey }),
    });

    if (!resp.ok) {
      resultadoDiv.textContent = "Error: " + (await resp.text());
      return;
    }

    const data = await resp.json();
    resultadoDiv.textContent =
      `Factura guardada (id ${data.factura_id}), proveedor id ${data.proveedor_id}, ` +
      `${data.items_cargados} ítems cargados.`;
  } catch (err) {
    console.error(err);
    resultadoDiv.textContent = "Error guardando la factura: " + err.message;
  }
});

// ============================================================
// TAB: OBJETOS DE COSTO
// ============================================================
async function cargarObjetosCosto() {
  const resp = await fetch("/api/objetos-costo");
  const objetos = await resp.json();
  const tbody = document.querySelector("#tabla-objetos tbody");
  tbody.innerHTML = "";
  objetos.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.tipo}</td><td>${o.nombre}</td><td>${o.identificador || ""}</td>
      <td><button type="button" class="btn-ver-movimientos">Ver movimientos</button></td>
    `;
    tr.querySelector(".btn-ver-movimientos").addEventListener("click", () => {
      verMovimientosObjeto(o.id, o.nombre);
    });
    tbody.appendChild(tr);
  });
  return objetos;
}

async function verMovimientosObjeto(objetoId, nombreObjeto) {
  const div = document.getElementById("objeto-movimientos-resultado");
  div.innerHTML = "<p class='hint'>Cargando movimientos...</p>";

  const data = await fetch(`/api/objetos-costo/${objetoId}/movimientos`).then((r) => r.json());

  if (data.movimientos.length === 0) {
    div.innerHTML = `<h3>${nombreObjeto}</h3><p class="hint">Todavía no tiene nada imputado.</p>`;
    return;
  }

  const arbol = agruparPorCategoriaJerarquica(data.movimientos);
  const arbolHtml = Object.values(arbol).map(renderNodoCategoria).join("");

  div.innerHTML = `
    <h3>${nombreObjeto}</h3>
    <p><strong>Total imputado: $${data.total.toFixed(2)}</strong></p>
    <div class="arbol-movimientos">${arbolHtml}</div>
  `;
}

// Agrupa los movimientos en: categoría principal -> (subcategoría opcional) -> producto -> movimientos.
// Los totales se mantienen separados por moneda (nunca se suma PES con USD).
function agruparPorCategoriaJerarquica(movimientos) {
  const raiz = {};

  const sumar = (nodo, m) => {
    nodo.totalesPorMoneda[m.moneda || "PES"] = (nodo.totalesPorMoneda[m.moneda || "PES"] || 0) + m.monto_imputado;
  };

  movimientos.forEach((m) => {
    const nombrePrincipal = m.categoria_padre || m.categoria || "Sin categoría";
    const esSubcategoria = !!m.categoria_padre;

    if (!raiz[nombrePrincipal]) {
      raiz[nombrePrincipal] = { nombre: nombrePrincipal, totalesPorMoneda: {}, subcategorias: {}, productos: {} };
    }
    const nodoCategoria = raiz[nombrePrincipal];
    sumar(nodoCategoria, m);

    let contenedorProductos;
    if (esSubcategoria) {
      if (!nodoCategoria.subcategorias[m.categoria]) {
        nodoCategoria.subcategorias[m.categoria] = { nombre: m.categoria, totalesPorMoneda: {}, productos: {} };
      }
      sumar(nodoCategoria.subcategorias[m.categoria], m);
      contenedorProductos = nodoCategoria.subcategorias[m.categoria].productos;
    } else {
      contenedorProductos = nodoCategoria.productos;
    }

    if (!contenedorProductos[m.producto]) {
      contenedorProductos[m.producto] = { nombre: m.producto, totalesPorMoneda: {}, movimientos: [] };
    }
    sumar(contenedorProductos[m.producto], m);
    contenedorProductos[m.producto].movimientos.push(m);
  });

  return raiz;
}

function formatoTotales(totalesPorMoneda) {
  return Object.entries(totalesPorMoneda)
    .map(([moneda, monto]) => `$${monto.toFixed(2)} ${moneda}`)
    .join(" + ");
}

function renderNodoProducto(producto) {
  const filas = producto.movimientos
    .map((m) => {
      const valor =
        m.cantidad_imputada != null ? `${m.cantidad_imputada} ${m.unidad_medida || ""}` : `${m.porcentaje}%`;
      return `<tr>
        <td>${m.fecha_emision}</td>
        <td>${m.proveedor}</td>
        <td>${valor}</td>
        <td>$${m.monto_imputado.toFixed(2)} ${m.moneda || "PES"}</td>
      </tr>`;
    })
    .join("");

  return `
    <details class="nodo-arbol nodo-producto">
      <summary>${producto.nombre} <span class="total-nodo">${formatoTotales(producto.totalesPorMoneda)}</span></summary>
      <table class="tabla-anidada">
        <thead><tr><th>Fecha</th><th>Proveedor</th><th>Cantidad / %</th><th>Monto</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </details>`;
}

function renderNodoSubcategoria(sub) {
  const productosHtml = Object.values(sub.productos).map(renderNodoProducto).join("");
  return `
    <details class="nodo-arbol nodo-subcategoria">
      <summary>↳ ${sub.nombre} <span class="total-nodo">${formatoTotales(sub.totalesPorMoneda)}</span></summary>
      ${productosHtml}
    </details>`;
}

function renderNodoCategoria(cat) {
  const subHtml = Object.values(cat.subcategorias).map(renderNodoSubcategoria).join("");
  const prodHtml = Object.values(cat.productos).map(renderNodoProducto).join("");
  return `
    <details class="nodo-arbol nodo-categoria" open>
      <summary>${cat.nombre} <span class="total-nodo">${formatoTotales(cat.totalesPorMoneda)}</span></summary>
      ${subHtml}
      ${prodHtml}
    </details>`;
}

document.getElementById("btn-crear-objeto").addEventListener("click", async () => {
  const tipo = document.getElementById("oc-tipo").value;
  const nombre = document.getElementById("oc-nombre").value.trim();
  const identificador = document.getElementById("oc-identificador").value.trim();

  if (!nombre) return alert("Ingresá un nombre");

  await fetch("/api/objetos-costo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo, nombre, identificador }),
  });

  document.getElementById("oc-nombre").value = "";
  document.getElementById("oc-identificador").value = "";
  cargarObjetosCosto();
});

async function cargarCategorias() {
  const resp = await fetch("/api/categorias");
  const categorias = await resp.json();

  const tbody = document.querySelector("#tabla-categorias tbody");
  tbody.innerHTML = "";
  categorias.forEach((c) => {
    const tr = document.createElement("tr");
    const nombreMostrado = c.categoria_padre_nombre
      ? `&nbsp;&nbsp;&nbsp;↳ ${c.nombre} <span class="hint">(de ${c.categoria_padre_nombre})</span>`
      : c.nombre;
    tr.innerHTML = `<td>${nombreMostrado}</td>`;
    tbody.appendChild(tr);
  });

  // el selector de "categoría padre" solo debe ofrecer categorías principales
  // (no se permite anidar subcategorías dentro de subcategorías)
  const selectPadre = document.getElementById("cat-padre");
  const seleccionActual = selectPadre.value;
  selectPadre.innerHTML =
    `<option value="">(categoría principal)</option>` +
    categorias
      .filter((c) => !c.categoria_padre_id)
      .map((c) => `<option value="${c.id}">${c.nombre}</option>`)
      .join("");
  selectPadre.value = seleccionActual;

  return categorias;
}

// Arma <option> ordenadas por categoría principal, con sus subcategorías
// indentadas justo debajo, para usar en cualquier selector de categoría.
function opcionesCategoriasConJerarquia(categorias, seleccionadaId = null) {
  const principales = categorias.filter((c) => !c.categoria_padre_id);
  let html = `<option value="">(sin categoría)</option>`;

  principales.forEach((principal) => {
    html += `<option value="${principal.id}" ${principal.id === seleccionadaId ? "selected" : ""}>${principal.nombre}</option>`;
    categorias
      .filter((c) => c.categoria_padre_id === principal.id)
      .forEach((sub) => {
        html += `<option value="${sub.id}" ${sub.id === seleccionadaId ? "selected" : ""}>&nbsp;&nbsp;↳ ${sub.nombre}</option>`;
      });
  });

  return html;
}

document.getElementById("btn-crear-categoria").addEventListener("click", async () => {
  const nombre = document.getElementById("cat-nombre").value.trim();
  const categoriaPadreId = document.getElementById("cat-padre").value;
  if (!nombre) return alert("Ingresá un nombre");

  await fetch("/api/categorias", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nombre, categoria_padre_id: categoriaPadreId || null }),
  });

  document.getElementById("cat-nombre").value = "";
  cargarCategorias();
});

document.querySelector('[data-tab="objetos"]').addEventListener("click", () => {
  cargarObjetosCosto();
  cargarCategorias();
});

// ============================================================
// TAB: PENDIENTES DE IMPUTAR
// ============================================================
async function cargarPendientes() {
  const tbody = document.querySelector("#tabla-pendientes tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="hint">Cargando...</td></tr>`;

  const pendientes = await fetch("/api/items/pendientes").then((r) => r.json());

  if (pendientes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">No hay nada pendiente de imputar — todo está asignado.</td></tr>`;
    return;
  }

  tbody.innerHTML = pendientes
    .map(
      (p) => `
      <tr>
        <td>${p.producto}</td>
        <td>${p.proveedor}</td>
        <td>${p.punto_venta}-${p.numero}</td>
        <td>${p.fecha_emision}</td>
        <td>${p.cantidad_restante_aprox} ${p.unidad_medida || ""}</td>
        <td>$${p.restante.toFixed(2)} ${p.moneda || "PES"}</td>
        <td><button type="button" class="btn-ir-a-imputar" data-factura-id="${p.factura_id}">Imputar</button></td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll(".btn-ir-a-imputar").forEach((btn) => {
    btn.addEventListener("click", () => {
      const facturaId = btn.dataset.facturaId;

      // cambia a la pestaña "Imputar"
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
      document.querySelector('[data-tab="imputar"]').classList.add("active");
      document.getElementById("tab-imputar").classList.add("active");

      document.getElementById("imp-factura-id").value = facturaId;
      document.getElementById("btn-cargar-items-imputar").click();
    });
  });
}

document.querySelector('[data-tab="pendientes"]').addEventListener("click", cargarPendientes);

// ============================================================
// TAB: IMPUTAR
// ============================================================
document.getElementById("btn-cargar-items-imputar").addEventListener("click", async () => {
  const facturaId = document.getElementById("imp-factura-id").value;
  if (!facturaId) return;

  const [itemsResp, objetos, categorias] = await Promise.all([
    fetch(`/api/facturas/${facturaId}/items`).then((r) => r.json()),
    cargarObjetosCosto(),
    fetch("/api/categorias").then((r) => r.json()),
  ]);

  const tbody = document.querySelector("#tabla-imputar tbody");
  tbody.innerHTML = "";

  itemsResp.forEach((item) => {
    const tr = document.createElement("tr");
    const opcionesObjetos = objetos
      .map((o) => `<option value="${o.id}">[${o.tipo}] ${o.nombre}</option>`)
      .join("");
    const opcionesCategorias = opcionesCategoriasConJerarquia(categorias);

    const baseTotal = item.subtotal_con_iva ?? item.subtotal;
    const restante = Math.max(0, baseTotal - item.monto_ya_imputado);
    const estadoHtml =
      restante <= 0.005
        ? `<span style="color:#3f6b4f">✔ Completo</span>`
        : `<span style="color:#b06a2c">Falta $${restante.toFixed(2)}</span>`;

    tr.innerHTML = `
      <td>${item.descripcion}</td>
      <td>${baseTotal.toFixed(2)}</td>
      <td>${item.monto_ya_imputado.toFixed(2)}</td>
      <td class="celda-estado">${estadoHtml}</td>
      <td><select class="sel-objeto">${opcionesObjetos}</select></td>
      <td><select class="sel-categoria">${opcionesCategorias}</select></td>
      <td>
        <input class="inp-cantidad-pct" type="number" step="0.0001" placeholder="cantidad">
        <select class="sel-modo">
          <option value="cantidad">${item.unidad_medida || "unidad"}</option>
          <option value="porcentaje">%</option>
        </select>
        <div style="color:#6b6f6a;font-size:11.5px;margin-top:2px">
          de ${item.cantidad} ${item.unidad_medida || "unidad"} en total
        </div>
      </td>
      <td><button type="button" class="btn-imputar">Imputar</button></td>
      <td><button type="button" class="btn-historial">Historial</button></td>
    `;

    tr.querySelector(".btn-historial").addEventListener("click", () => {
      toggleHistorial(tr, item);
    });

    tr.querySelector(".btn-imputar").addEventListener("click", async () => {
      const objetoCostoId = tr.querySelector(".sel-objeto").value;
      const categoriaId = tr.querySelector(".sel-categoria").value;
      const valor = parseFloat(tr.querySelector(".inp-cantidad-pct").value);
      const modo = tr.querySelector(".sel-modo").value;

      if (!valor) return alert("Ingresá una cantidad o porcentaje");

      const body = { item_id: item.id, objeto_costo_id: objetoCostoId };
      if (modo === "cantidad") body.cantidad_imputada = valor;
      else body.porcentaje = valor;
      if (categoriaId) body.categoria_id = categoriaId;

      const resp = await fetch("/api/imputaciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const resultadoDiv = document.getElementById("resultado-imputacion");
      if (resp.ok) {
        const data = await resp.json();
        resultadoDiv.textContent = data.completo
          ? `Imputado $${data.monto_imputado.toFixed(2)} — ítem completo.`
          : `Imputado $${data.monto_imputado.toFixed(2)} — faltan $${data.restante.toFixed(2)} por imputar.`;
        document.getElementById("btn-cargar-items-imputar").click(); // refresca
      } else {
        resultadoDiv.textContent = "Error: " + (await resp.text());
      }
    });

    tbody.appendChild(tr);
  });
});

// --- historial de imputaciones por ítem: mostrar, editar, eliminar ---
async function toggleHistorial(filaItem, item) {
  const filaSiguiente = filaItem.nextElementSibling;
  if (filaSiguiente && filaSiguiente.classList.contains("fila-historial")) {
    filaSiguiente.remove(); // ya estaba abierto -> lo cierra
    return;
  }

  const filaHistorial = document.createElement("tr");
  filaHistorial.className = "fila-historial";
  const celda = document.createElement("td");
  celda.colSpan = 9;
  celda.innerHTML = "Cargando historial...";
  filaHistorial.appendChild(celda);
  filaItem.after(filaHistorial);

  const historial = await fetch(`/api/items/${item.id}/imputaciones`).then((r) => r.json());

  if (historial.length === 0) {
    celda.innerHTML = `<span class="hint">Todavía no se imputó nada de este ítem.</span>`;
    return;
  }

  celda.innerHTML = `
    <table style="margin:4px 0">
      <thead>
        <tr><th>Objeto de costo</th><th>Categoría</th><th>Cantidad / %</th><th>Monto</th><th>Fecha</th><th></th></tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const cuerpoHistorial = celda.querySelector("tbody");

  historial.forEach((imp) => {
    const filaImp = document.createElement("tr");
    const valorMostrado =
      imp.cantidad_imputada != null
        ? `${imp.cantidad_imputada} ${item.unidad_medida || "unidad"}`
        : `${imp.porcentaje}%`;

    filaImp.innerHTML = `
      <td>[${imp.objeto_tipo}] ${imp.objeto_nombre}</td>
      <td class="celda-categoria">${imp.categoria || "<span class='hint'>sin categoría</span>"} <button type="button" class="btn-editar-categoria" style="font-size:11px;padding:2px 6px">✎</button></td>
      <td class="celda-valor">${valorMostrado}</td>
      <td>$${imp.monto_imputado.toFixed(2)}</td>
      <td>${new Date(imp.creado_en).toLocaleDateString("es-AR")}</td>
      <td>
        <button type="button" class="btn-editar-imp">Editar</button>
        <button type="button" class="btn-eliminar-imp">Eliminar</button>
      </td>
    `;

    filaImp.querySelector(".btn-editar-categoria").addEventListener("click", async () => {
      const celdaCategoria = filaImp.querySelector(".celda-categoria");
      const categorias = await fetch("/api/categorias").then((r) => r.json());
      const opciones = opcionesCategoriasConJerarquia(categorias, imp.categoria_id);

      celdaCategoria.innerHTML = `
        <select class="sel-editar-categoria">${opciones}</select>
        <button type="button" class="btn-guardar-categoria">Guardar</button>
      `;

      celdaCategoria.querySelector(".btn-guardar-categoria").addEventListener("click", async () => {
        const nuevaCategoriaId = celdaCategoria.querySelector(".sel-editar-categoria").value;

        const resp = await fetch(`/api/imputaciones/${imp.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categoria_id: nuevaCategoriaId || null }),
        });

        if (resp.ok) {
          document.getElementById("btn-cargar-items-imputar").click(); // refresca todo
        } else {
          alert("Error: " + (await resp.text()));
        }
      });
    });

    filaImp.querySelector(".btn-eliminar-imp").addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta imputación?")) return;
      const resp = await fetch(`/api/imputaciones/${imp.id}`, { method: "DELETE" });
      if (resp.ok) {
        document.getElementById("btn-cargar-items-imputar").click(); // refresca todo
      } else {
        alert("Error: " + (await resp.text()));
      }
    });

    filaImp.querySelector(".btn-editar-imp").addEventListener("click", () => {
      const esCantidad = imp.cantidad_imputada != null;
      const celdaValor = filaImp.querySelector(".celda-valor");
      celdaValor.innerHTML = `
        <input type="number" step="0.0001" class="inp-editar-valor" value="${esCantidad ? imp.cantidad_imputada : imp.porcentaje}" style="width:80px">
        ${esCantidad ? item.unidad_medida || "unidad" : "%"}
        <button type="button" class="btn-guardar-edicion">Guardar</button>
      `;

      celdaValor.querySelector(".btn-guardar-edicion").addEventListener("click", async () => {
        const nuevoValor = parseFloat(celdaValor.querySelector(".inp-editar-valor").value);
        if (!nuevoValor) return alert("Ingresá un valor válido");

        const body = esCantidad ? { cantidad_imputada: nuevoValor } : { porcentaje: nuevoValor };

        const resp = await fetch(`/api/imputaciones/${imp.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (resp.ok) {
          document.getElementById("btn-cargar-items-imputar").click(); // refresca todo
        } else {
          alert("Error: " + (await resp.text()));
        }
      });
    });

    cuerpoHistorial.appendChild(filaImp);
  });
}

// ============================================================
// TAB: RESUMEN POR PROVEEDOR
// ============================================================
let timeoutBusquedaProveedor = null;

document.getElementById("res-busqueda-proveedor").addEventListener("input", (e) => {
  clearTimeout(timeoutBusquedaProveedor);
  const texto = e.target.value.trim();
  const contenedorResultados = document.getElementById("res-resultados-busqueda");

  if (texto.length < 2) {
    contenedorResultados.style.display = "none";
    contenedorResultados.innerHTML = "";
    return;
  }

  timeoutBusquedaProveedor = setTimeout(async () => {
    const proveedores = await fetch(`/api/proveedores?q=${encodeURIComponent(texto)}`).then((r) => r.json());

    if (proveedores.length === 0) {
      contenedorResultados.style.display = "block";
      contenedorResultados.innerHTML = `<div class="resultado-proveedor hint">Sin resultados</div>`;
      return;
    }

    contenedorResultados.style.display = "block";
    contenedorResultados.innerHTML = proveedores
      .map(
        (p) => `
        <div class="resultado-proveedor" data-id="${p.id}">
          ${p.razon_social}
          <small>CUIT ${p.cuit}</small>
        </div>`
      )
      .join("");

    contenedorResultados.querySelectorAll(".resultado-proveedor[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const proveedor = proveedores.find((p) => String(p.id) === el.dataset.id);
        document.getElementById("res-busqueda-proveedor").value = "";
        contenedorResultados.style.display = "none";
        contenedorResultados.innerHTML = "";
        document.getElementById("res-proveedor-seleccionado").textContent =
          `Viendo cuenta de: ${proveedor.razon_social} (CUIT ${proveedor.cuit})`;
        cargarResumenProveedor(proveedor.id);
      });
    });
  }, 300); // debounce: espera que el usuario deje de tipear
});

async function cargarResumenProveedor(proveedorId) {
  const resp = await fetch(`/api/resumen/${proveedorId}`);
  const data = await resp.json();
  const productos = await fetch(`/api/resumen/${proveedorId}/productos`).then((r) => r.json());
  const div = document.getElementById("resumen-resultado");

  if (!data.saldo) {
    div.innerHTML = "<p class='hint'>No se encontró el proveedor.</p>";
    return;
  }

  div.innerHTML = `
    <h3 id="nombre-proveedor-resumen">${data.saldo.razon_social}
      <button type="button" id="btn-editar-razon-social" style="font-size:12px;margin-left:8px">Editar</button>
    </h3>
    <div id="form-editar-proveedor" style="display:none;margin-bottom:10px">
      <input type="text" id="inp-nueva-razon-social" value="${data.saldo.razon_social}" style="width:300px">
      <button type="button" id="btn-guardar-razon-social" class="primary">Guardar</button>
    </div>

    <h4>Saldo por moneda</h4>
    <table>
      <thead><tr><th>Moneda</th><th>Facturado</th><th>Pagado</th><th>Pendiente</th></tr></thead>
      <tbody>
        ${data.saldos_por_moneda
          .map(
            (s) => `<tr>
              <td>${s.moneda}</td>
              <td>$${s.total_facturado.toFixed(2)}</td>
              <td>$${s.total_pagado.toFixed(2)}</td>
              <td><strong>$${s.saldo_pendiente.toFixed(2)}</strong></td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <table id="tabla-facturas-resumen">
      <thead><tr><th>Tipo</th><th>Pto Vta</th><th>Número</th><th>Fecha</th><th>Total</th><th>Moneda</th><th>T.C.</th><th>Estado</th><th>Pendiente</th><th></th><th></th><th></th><th></th></tr></thead>
      <tbody>
        ${data.facturas
          .map(
            (f) => `<tr data-factura-id="${f.id}">
                        <td>${f.tipo_cbte}</td><td>${f.punto_venta}</td><td>${f.numero}</td>
                        <td>${f.fecha_emision}</td><td>$${f.total.toFixed(2)}</td>
                        <td>${f.moneda || "PES"}</td>
                        <td>${f.tipo_cambio ? f.tipo_cambio : "<span class='hint'>—</span>"}</td>
                        <td>${f.estado_pago}</td>
                        <td>$${f.saldo_pendiente.toFixed(2)}</td>
                        <td>${f.saldo_pendiente > 0 ? `<button type="button" class="btn-pagar-factura" data-factura-id="${f.id}" data-saldo="${f.saldo_pendiente}" data-moneda="${f.moneda || "PES"}">Pagar</button>` : ""}</td>
                        <td><button type="button" class="btn-ver-pagos" data-factura-id="${f.id}">Ver pagos</button></td>
                        <td><button type="button" class="btn-editar-factura" data-factura-id="${f.id}">Editar</button></td>
                        <td><button type="button" class="btn-eliminar-factura" data-factura-id="${f.id}">Eliminar</button></td>
                      </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <h4>Resumen por producto (todas las facturas de este proveedor)</h4>
    <table>
      <thead>
        <tr><th>Producto</th><th>Comprado total</th><th>Ya imputado</th><th>Disponible (sin imputar)</th></tr>
      </thead>
      <tbody>
        ${productos
          .map(
            (p) => `<tr>
              <td>${p.producto}</td>
              <td>${p.cantidad_total} ${p.unidad_medida} — $${p.monto_total.toFixed(2)} ${p.moneda}</td>
              <td>$${p.monto_imputado.toFixed(2)} ${p.moneda}</td>
              <td>${p.cantidad_disponible_aprox} ${p.unidad_medida} — $${p.monto_disponible.toFixed(2)} ${p.moneda}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  document.getElementById("btn-editar-razon-social").addEventListener("click", () => {
    document.getElementById("form-editar-proveedor").style.display = "block";
  });

  document.getElementById("btn-guardar-razon-social").addEventListener("click", async () => {
    const nuevaRazonSocial = document.getElementById("inp-nueva-razon-social").value.trim();
    if (!nuevaRazonSocial) return alert("Ingresá un nombre");

    const resp = await fetch(`/api/proveedores/${data.saldo.proveedor_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ razon_social: nuevaRazonSocial }),
    });

    if (resp.ok) {
      cargarResumenProveedor(proveedorId); // refresca con el nombre nuevo
    } else {
      alert("Error: " + (await resp.text()));
    }
  });

  // --- botón "Pagar": despliega un formulario inline debajo de la factura ---
  document.querySelectorAll(".btn-pagar-factura").forEach((btn) => {
    btn.addEventListener("click", () => {
      const facturaId = btn.dataset.facturaId;
      const filaFactura = document.querySelector(`tr[data-factura-id="${facturaId}"]`);
      const filaSiguiente = filaFactura.nextElementSibling;

      if (filaSiguiente && filaSiguiente.classList.contains("fila-pago-form")) {
        filaSiguiente.remove();
        return;
      }
      document.querySelectorAll(".fila-pago-form").forEach((f) => f.remove());

      const hoy = new Date().toISOString().slice(0, 10);
      const filaForm = document.createElement("tr");
      filaForm.className = "fila-pago-form";
      filaForm.innerHTML = `
        <td colspan="13">
          <strong>Registrar pago</strong> (${btn.dataset.moneda}) —
          Monto <input type="number" step="0.01" class="inp-pago-monto" value="${btn.dataset.saldo}" style="width:110px">
          Fecha <input type="date" class="inp-pago-fecha" value="${hoy}">
          Medio
          <select class="inp-pago-medio">
            <option value="transferencia">Transferencia</option>
            <option value="efectivo">Efectivo</option>
            <option value="cheque">Cheque</option>
            <option value="otro">Otro</option>
          </select>
          Referencia <input type="text" class="inp-pago-referencia" placeholder="opcional" style="width:140px">
          <button type="button" class="primary btn-confirmar-pago">Confirmar</button>
        </td>
      `;
      filaFactura.after(filaForm);

      filaForm.querySelector(".btn-confirmar-pago").addEventListener("click", async () => {
        const monto = parseFloat(filaForm.querySelector(".inp-pago-monto").value);
        const fecha_pago = filaForm.querySelector(".inp-pago-fecha").value;
        const medio_pago = filaForm.querySelector(".inp-pago-medio").value;
        const referencia = filaForm.querySelector(".inp-pago-referencia").value.trim();

        if (!monto || monto <= 0) return alert("Ingresá un monto válido");
        if (!fecha_pago) return alert("Ingresá una fecha");

        const resp = await fetch("/api/pagos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factura_id: facturaId, monto, fecha_pago, medio_pago, referencia }),
        });

        if (resp.ok) {
          cargarResumenProveedor(proveedorId); // refresca saldo y estado
        } else {
          alert("Error: " + (await resp.text()));
        }
      });
    });
  });

  // --- botón "Ver pagos": despliega el historial de pagos de esa factura ---
  document.querySelectorAll(".btn-ver-pagos").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const facturaId = btn.dataset.facturaId;
      const filaFactura = document.querySelector(`tr[data-factura-id="${facturaId}"]`);
      const filaSiguiente = filaFactura.nextElementSibling;

      if (filaSiguiente && filaSiguiente.classList.contains("fila-pagos-historial")) {
        filaSiguiente.remove();
        return;
      }
      document.querySelectorAll(".fila-pagos-historial").forEach((f) => f.remove());

      const pagos = await fetch(`/api/facturas/${facturaId}/pagos`).then((r) => r.json());

      const filaHist = document.createElement("tr");
      filaHist.className = "fila-pagos-historial";
      const celda = document.createElement("td");
      celda.colSpan = 13;

      if (pagos.length === 0) {
        celda.innerHTML = `<span class="hint">Todavía no se registró ningún pago para esta factura.</span>`;
      } else {
        celda.innerHTML = `
          <table style="margin:4px 0">
            <thead><tr><th>Fecha</th><th>Medio</th><th>Referencia</th><th>Monto</th><th></th></tr></thead>
            <tbody>
              ${pagos
                .map(
                  (p) => `<tr data-pago-id="${p.id}">
                    <td>${p.fecha_pago}</td><td>${p.medio_pago || ""}</td><td>${p.referencia || ""}</td>
                    <td>$${p.monto_aplicado.toFixed(2)}</td>
                    <td><button type="button" class="btn-eliminar-pago" data-pago-id="${p.id}">Eliminar</button></td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        `;
      }
      filaHist.appendChild(celda);
      filaFactura.after(filaHist);

      celda.querySelectorAll(".btn-eliminar-pago").forEach((btnEliminar) => {
        btnEliminar.addEventListener("click", async () => {
          if (!confirm("¿Eliminar este pago?")) return;
          const resp = await fetch(`/api/pagos/${btnEliminar.dataset.pagoId}`, { method: "DELETE" });
          if (resp.ok) {
            cargarResumenProveedor(proveedorId);
          } else {
            alert("Error: " + (await resp.text()));
          }
        });
      });
    });
  });

  // --- botón "Eliminar" factura ---
  document.querySelectorAll(".btn-eliminar-factura").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta factura completa? Se borran también sus ítems e imputaciones.")) return;

      const resp = await fetch(`/api/facturas/${btn.dataset.facturaId}`, { method: "DELETE" });
      if (resp.ok) {
        cargarResumenProveedor(proveedorId);
      } else {
        alert("Error: " + (await resp.text()));
      }
    });
  });

  // --- botón "Editar" factura: despliega cabecera + ítems editables ---
  document.querySelectorAll(".btn-editar-factura").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleEditorFactura(btn.dataset.facturaId, proveedorId);
    });
  });
}

async function toggleEditorFactura(facturaId, proveedorId) {
  const filaFactura = document.querySelector(`tr[data-factura-id="${facturaId}"]`);
  const filaSiguiente = filaFactura.nextElementSibling;

  if (filaSiguiente && filaSiguiente.classList.contains("fila-editor-factura")) {
    filaSiguiente.remove();
    return;
  }
  document.querySelectorAll(".fila-editor-factura, .fila-pago-form, .fila-pagos-historial").forEach((f) =>
    f.remove()
  );

  const [factura, items] = await Promise.all([
    fetch(`/api/facturas/${facturaId}`).then((r) => r.json()),
    fetch(`/api/facturas/${facturaId}/items`).then((r) => r.json()),
  ]);

  const filaEditor = document.createElement("tr");
  filaEditor.className = "fila-editor-factura";
  const celda = document.createElement("td");
  celda.colSpan = 13;
  celda.innerHTML = `
    <div style="padding:10px;background:#fff;border:1px solid var(--borde);border-radius:8px">
      <h4 style="margin-top:0">Cabecera</h4>
      <div class="grid-form">
        <label>Número <input class="ed-numero" type="text" value="${factura.numero}"></label>
        <label>Punto de venta <input class="ed-ptovta" type="text" value="${factura.punto_venta}"></label>
        <label>Tipo comprobante <input class="ed-tipo" type="text" value="${factura.tipo_cbte}"></label>
        <label>Fecha <input class="ed-fecha" type="text" value="${factura.fecha_emision}"></label>
        <label>CAE <input class="ed-cae" type="text" value="${factura.cae || ""}"></label>
        <label>Moneda <input class="ed-moneda" type="text" value="${factura.moneda || "PES"}"></label>
        <label>Tipo de cambio <input class="ed-tc" type="number" step="0.000001" value="${factura.tipo_cambio || ""}"></label>
        <label>Total <input class="ed-total" type="number" step="0.01" value="${factura.total}"></label>
      </div>
      <button type="button" class="primary btn-guardar-cabecera">Guardar cabecera</button>
      <div class="resultado-editor-cabecera hint"></div>

      <h4>Ítems</h4>
      <table class="tabla-editor-items">
        <thead>
          <tr><th>Descripción</th><th>Cant.</th><th>Unidad</th><th>Precio</th><th>% IVA</th><th>Subtotal</th><th>Subt. c/IVA</th><th></th></tr>
        </thead>
        <tbody></tbody>
      </table>
      <button type="button" class="btn-agregar-item-editor">+ Agregar ítem</button>
      <div class="resultado-editor-items hint"></div>
    </div>
  `;
  filaFactura.after(filaEditor);

  const tbodyItems = celda.querySelector(".tabla-editor-items tbody");

  function agregarFilaEditor(item) {
    const tr = document.createElement("tr");
    tr.dataset.itemId = item?.id || "";
    tr.innerHTML = `
      <td><input class="ei-descripcion" type="text" value="${item?.descripcion || ""}"></td>
      <td><input class="ei-cantidad" type="number" step="0.0001" value="${item?.cantidad ?? ""}" style="width:70px"></td>
      <td><input class="ei-unidad" type="text" value="${item?.unidad_medida || "unidad"}" style="width:70px"></td>
      <td><input class="ei-precio" type="number" step="0.0001" value="${item?.precio_unitario ?? ""}" style="width:90px"></td>
      <td><input class="ei-iva" type="number" step="0.01" value="${item?.alicuota_iva ?? 21}" style="width:60px"></td>
      <td><input class="ei-subtotal" type="number" step="0.01" value="${item?.subtotal ?? ""}" style="width:90px"></td>
      <td><input class="ei-subtotal-con-iva" type="number" step="0.01" value="${item?.subtotal_con_iva ?? ""}" style="width:90px"></td>
      <td>
        <button type="button" class="btn-guardar-item-editor">Guardar</button>
        <button type="button" class="btn-eliminar-item-editor">Eliminar</button>
      </td>
    `;

    tr.querySelector(".btn-guardar-item-editor").addEventListener("click", async () => {
      const datos = {
        descripcion: tr.querySelector(".ei-descripcion").value.trim(),
        cantidad: parseFloat(tr.querySelector(".ei-cantidad").value) || 0,
        unidad_medida: tr.querySelector(".ei-unidad").value.trim() || "unidad",
        precio_unitario: parseFloat(tr.querySelector(".ei-precio").value) || 0,
        alicuota_iva: parseFloat(tr.querySelector(".ei-iva").value) || 0,
        subtotal: parseFloat(tr.querySelector(".ei-subtotal").value) || 0,
        subtotal_con_iva: parseFloat(tr.querySelector(".ei-subtotal-con-iva").value) || null,
      };

      const divResultado = celda.querySelector(".resultado-editor-items");

      if (tr.dataset.itemId) {
        const resp = await fetch(`/api/factura-items/${tr.dataset.itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(datos),
        });
        divResultado.textContent = resp.ok ? "Ítem actualizado." : "Error: " + (await resp.text());
      } else {
        const resp = await fetch(`/api/facturas/${facturaId}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(datos),
        });
        if (resp.ok) {
          const nuevo = await resp.json();
          tr.dataset.itemId = nuevo.id;
          divResultado.textContent = "Ítem agregado.";
        } else {
          divResultado.textContent = "Error: " + (await resp.text());
        }
      }
    });

    tr.querySelector(".btn-eliminar-item-editor").addEventListener("click", async () => {
      if (!tr.dataset.itemId) {
        tr.remove(); // fila nueva sin guardar todavía, se borra sin llamar a la API
        return;
      }
      if (!confirm("¿Eliminar este ítem?")) return;

      const resp = await fetch(`/api/factura-items/${tr.dataset.itemId}`, { method: "DELETE" });
      if (resp.ok) {
        tr.remove();
      } else {
        celda.querySelector(".resultado-editor-items").textContent = "Error: " + (await resp.text());
      }
    });

    tbodyItems.appendChild(tr);
  }

  items.forEach((item) => agregarFilaEditor(item));

  celda.querySelector(".btn-agregar-item-editor").addEventListener("click", () => agregarFilaEditor(null));

  celda.querySelector(".btn-guardar-cabecera").addEventListener("click", async () => {
    const datos = {
      numero: celda.querySelector(".ed-numero").value.trim(),
      punto_venta: celda.querySelector(".ed-ptovta").value.trim(),
      tipo_cbte: celda.querySelector(".ed-tipo").value.trim(),
      fecha_emision: celda.querySelector(".ed-fecha").value.trim(),
      cae: celda.querySelector(".ed-cae").value.trim(),
      moneda: celda.querySelector(".ed-moneda").value.trim(),
      tipo_cambio: parseFloat(celda.querySelector(".ed-tc").value) || null,
      total: parseFloat(celda.querySelector(".ed-total").value) || 0,
    };

    const resp = await fetch(`/api/facturas/${facturaId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(datos),
    });

    const divResultado = celda.querySelector(".resultado-editor-cabecera");
    if (resp.ok) {
      divResultado.textContent = "Cabecera actualizada.";
      cargarResumenProveedor(proveedorId);
    } else {
      divResultado.textContent = "Error: " + (await resp.text());
    }
  });

  filaEditor.appendChild(celda);
}

// ============================================================
// TAB: DASHBOARD
// ============================================================
const NOMBRES_MES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function formatoMonedas(lista) {
  if (!lista || lista.length === 0) return `<span class="hint">$0.00</span>`;
  return lista.map((l) => `$${l.monto.toFixed(2)} ${l.moneda}`).join(" + ");
}

async function cargarDashboard() {
  const contenedor = document.getElementById("dashboard-contenido");
  contenedor.innerHTML = `<p class="hint">Cargando...</p>`;

  const data = await fetch("/api/dashboard").then((r) => r.json());

  const [anio, mesNum] = data.mes.split("-");
  const nombreMes = NOMBRES_MES[parseInt(mesNum, 10) - 1];

  // una fila por cada combinación categoría+moneda que ya viene de la API
  const htmlCategorias = data.gasto_mes_por_categoria.length
    ? data.gasto_mes_por_categoria
        .map((c) => {
          const etiqueta = c.categoria_padre
            ? `${c.categoria_padre} ↳ ${c.categoria || "Sin categoría"}`
            : c.categoria || "Sin categoría";
          return `<div class="dashboard-fila"><span>${etiqueta}</span><span class="valor">$${c.monto.toFixed(2)} ${c.moneda}</span></div>`;
        })
        .join("")
    : `<p class="hint">Todavía no imputaste nada este mes.</p>`;

  const htmlProveedores = data.proveedores_pendientes.length
    ? data.proveedores_pendientes
        .map(
          (p) =>
            `<div class="dashboard-fila"><span>${p.razon_social}</span><span class="valor">$${p.saldo_pendiente.toFixed(2)} ${p.moneda}</span></div>`
        )
        .join("")
    : `<p class="hint">No hay saldos pendientes.</p>`;

  contenedor.innerHTML = `
    <p class="hint">Datos de ${nombreMes} ${anio}</p>
    <div class="dashboard-grid">
      <div class="dashboard-tarjeta">
        <h3>Gasto imputado este mes</h3>
        <div class="dashboard-monto-grande">${formatoMonedas(data.gasto_mes_total_por_moneda)}</div>
      </div>

      <div class="dashboard-tarjeta">
        <h3>Pendientes de imputar</h3>
        <div class="dashboard-monto-grande">${data.pendientes_imputar.cantidad_items}</div>
        <p class="hint" style="margin:0">ítems — ${formatoMonedas(data.pendientes_imputar.restante_por_moneda)}</p>
      </div>

      <div class="dashboard-tarjeta">
        <h3>Gasto del mes por categoría</h3>
        ${htmlCategorias}
      </div>

      <div class="dashboard-tarjeta">
        <h3>Proveedores con saldo pendiente</h3>
        ${htmlProveedores}
      </div>
    </div>
  `;
}

document.querySelector('[data-tab="dashboard"]').addEventListener("click", cargarDashboard);
cargarDashboard(); // se carga también al entrar, porque es la pantalla inicial

// ============================================================
// TAB: EXPORTAR
// ============================================================

// Arma un CSV (separado por ";" y con BOM UTF-8, para que Excel en
// configuración regional Argentina lo abra bien de una) y dispara la
// descarga en el navegador.
function descargarCsv(filas, columnas, nombreArchivo) {
  const escaparCelda = (valor) => {
    const texto = valor === null || valor === undefined ? "" : String(valor);
    if (texto.includes(";") || texto.includes('"') || texto.includes("\n")) {
      return `"${texto.replace(/"/g, '""')}"`;
    }
    return texto;
  };

  const encabezado = columnas.map((c) => c.titulo).join(";");
  const cuerpo = filas
    .map((fila) => columnas.map((c) => escaparCelda(c.valor(fila))).join(";"))
    .join("\n");

  const contenido = "\uFEFF" + encabezado + "\n" + cuerpo;
  const blob = new Blob([contenido], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  document.body.removeChild(enlace);
  URL.revokeObjectURL(url);
}

document.getElementById("btn-exportar-iva").addEventListener("click", async () => {
  const desde = document.getElementById("exp-desde").value;
  const hasta = document.getElementById("exp-hasta").value;
  const divResultado = document.getElementById("exp-resultado-iva");

  if (!desde || !hasta) return alert("Completá las fechas 'Desde' y 'Hasta'");

  divResultado.textContent = "Generando...";
  const resp = await fetch(`/api/exportar/iva-compras?desde=${desde}&hasta=${hasta}`);

  if (!resp.ok) {
    divResultado.textContent = "Error: " + (await resp.text());
    return;
  }

  const filas = await resp.json();
  if (filas.length === 0) {
    divResultado.textContent = "No hay facturas en ese rango de fechas.";
    return;
  }

  descargarCsv(
    filas,
    [
      { titulo: "Fecha", valor: (f) => f.fecha_emision },
      { titulo: "Tipo Cbte", valor: (f) => f.tipo_cbte },
      { titulo: "Punto de Venta", valor: (f) => f.punto_venta },
      { titulo: "Número", valor: (f) => f.numero },
      { titulo: "CUIT Proveedor", valor: (f) => f.cuit },
      { titulo: "Razón Social", valor: (f) => f.razon_social },
      { titulo: "Neto Gravado", valor: (f) => f.neto.toFixed(2) },
      { titulo: "IVA", valor: (f) => f.iva.toFixed(2) },
      { titulo: "Total", valor: (f) => f.total_con_iva.toFixed(2) },
      { titulo: "Moneda", valor: (f) => f.moneda || "PES" },
      { titulo: "CAE", valor: (f) => f.cae },
    ],
    `libro_iva_compras_${desde}_a_${hasta}.csv`
  );
  divResultado.textContent = `Descargado: ${filas.length} facturas.`;
});

document.getElementById("btn-exportar-imputaciones").addEventListener("click", async () => {
  const desde = document.getElementById("exp-desde").value;
  const hasta = document.getElementById("exp-hasta").value;
  const divResultado = document.getElementById("exp-resultado-imputaciones");

  if (!desde || !hasta) return alert("Completá las fechas 'Desde' y 'Hasta'");

  divResultado.textContent = "Generando...";
  const resp = await fetch(`/api/exportar/imputaciones?desde=${desde}&hasta=${hasta}`);

  if (!resp.ok) {
    divResultado.textContent = "Error: " + (await resp.text());
    return;
  }

  const filas = await resp.json();
  if (filas.length === 0) {
    divResultado.textContent = "No hay imputaciones en ese rango de fechas.";
    return;
  }

  descargarCsv(
    filas,
    [
      { titulo: "Fecha Imputación", valor: (f) => f.fecha_imputacion },
      { titulo: "Fecha Factura", valor: (f) => f.fecha_emision },
      { titulo: "Proveedor", valor: (f) => f.proveedor },
      { titulo: "Producto", valor: (f) => f.producto },
      { titulo: "Categoría", valor: (f) => (f.categoria_padre ? `${f.categoria_padre} > ${f.categoria}` : f.categoria || "") },
      { titulo: "Objeto de Costo", valor: (f) => `[${f.objeto_tipo}] ${f.objeto_nombre}` },
      { titulo: "Cantidad", valor: (f) => (f.cantidad_imputada != null ? `${f.cantidad_imputada} ${f.unidad_medida || ""}` : "") },
      { titulo: "Porcentaje", valor: (f) => (f.porcentaje != null ? `${f.porcentaje}%` : "") },
      { titulo: "Monto", valor: (f) => f.monto_imputado.toFixed(2) },
      { titulo: "Moneda", valor: (f) => f.moneda || "PES" },
    ],
    `detalle_imputaciones_${desde}_a_${hasta}.csv`
  );
  divResultado.textContent = `Descargado: ${filas.length} imputaciones.`;
});