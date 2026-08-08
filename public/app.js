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

  try {
    const arrayBuffer = await archivo.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let textoCompleto = "";
    qrDetectado = null;

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

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const resultado = jsQR(imageData.data, imageData.width, imageData.height);

        if (resultado) {
          qrDetectado = decodificarQrAfip(resultado.data);
        }
      }
    }

    if (qrDetectado) {
      estado.textContent = "QR de AFIP detectado. Revisá los datos antes de guardar.";
      completarCabeceraDesdeQr(qrDetectado);
    } else {
      estado.textContent =
        "No se pudo leer el QR de AFIP en este PDF. Completá los datos de cabecera a mano.";
      completarCabeceraDesdeQr({});
    }

    const itemsDetectados = intentarDetectarItems(textoCompleto);
    renderizarItems(itemsDetectados);

    document.getElementById("bloque-cabecera").style.display = "block";
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
    // los párrafos de texto legal son oraciones normales (minúsculas);
    // las descripciones de producto en facturas AR suelen ir en mayúsculas
    if (linea.length > 70) continue;

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

    items.push({
      descripcion,
      cantidad: cantidad || 1,
      unidad_medida: "unidad",
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
      moneda: "PES",
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
    tr.innerHTML = `<td>${o.tipo}</td><td>${o.nombre}</td><td>${o.identificador || ""}</td>`;
    tbody.appendChild(tr);
  });
  return objetos;
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

document.querySelector('[data-tab="objetos"]').addEventListener("click", cargarObjetosCosto);

// ============================================================
// TAB: IMPUTAR
// ============================================================
document.getElementById("btn-cargar-items-imputar").addEventListener("click", async () => {
  const facturaId = document.getElementById("imp-factura-id").value;
  if (!facturaId) return;

  const [itemsResp, objetos] = await Promise.all([
    fetch(`/api/facturas/${facturaId}/items`).then((r) => r.json()),
    cargarObjetosCosto(),
  ]);

  const tbody = document.querySelector("#tabla-imputar tbody");
  tbody.innerHTML = "";

  itemsResp.forEach((item) => {
    const tr = document.createElement("tr");
    const opcionesObjetos = objetos
      .map((o) => `<option value="${o.id}">[${o.tipo}] ${o.nombre}</option>`)
      .join("");

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
    `;

    tr.querySelector(".btn-imputar").addEventListener("click", async () => {
      const objetoCostoId = tr.querySelector(".sel-objeto").value;
      const valor = parseFloat(tr.querySelector(".inp-cantidad-pct").value);
      const modo = tr.querySelector(".sel-modo").value;

      if (!valor) return alert("Ingresá una cantidad o porcentaje");

      const body = { item_id: item.id, objeto_costo_id: objetoCostoId };
      if (modo === "cantidad") body.cantidad_imputada = valor;
      else body.porcentaje = valor;

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

// ============================================================
// TAB: RESUMEN POR PROVEEDOR
// ============================================================
document.getElementById("btn-ver-resumen").addEventListener("click", async () => {
  const proveedorId = document.getElementById("res-proveedor-id").value;
  if (!proveedorId) return;

  const resp = await fetch(`/api/resumen/${proveedorId}`);
  const data = await resp.json();
  const div = document.getElementById("resumen-resultado");

  if (!data.saldo) {
    div.innerHTML = "<p class='hint'>No se encontró el proveedor.</p>";
    return;
  }

  div.innerHTML = `
    <h3>${data.saldo.razon_social}</h3>
    <p>Total facturado: $${data.saldo.total_facturado.toFixed(2)} —
       Total pagado: $${data.saldo.total_pagado.toFixed(2)} —
       <strong>Saldo pendiente: $${data.saldo.saldo_pendiente.toFixed(2)}</strong></p>
    <table>
      <thead><tr><th>Tipo</th><th>Pto Vta</th><th>Número</th><th>Fecha</th><th>Total</th><th>Estado</th></tr></thead>
      <tbody>
        ${data.facturas
          .map(
            (f) => `<tr><td>${f.tipo_cbte}</td><td>${f.punto_venta}</td><td>${f.numero}</td>
                        <td>${f.fecha_emision}</td><td>$${f.total.toFixed(2)}</td><td>${f.estado_pago}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
});