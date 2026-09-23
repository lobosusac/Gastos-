"use strict";

// Símbolo de moneda: cámbialo aquí si usas otra (ej. "$", "€").
const MONEDA = "Q";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => MONEDA + " " + Number(n).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hoy = () => new Date().toLocaleDateString("en-CA"); // AAAA-MM-DD en hora local
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fechaCorta = (f) => f ? new Date(f + "T00:00:00").toLocaleDateString("es-GT", { day: "2-digit", month: "short", year: "numeric" }) : "";

let gastos = [];
let firmas = new Map();          // id -> firma de valores, para resaltar cambios
const abiertos = new Set();      // ids con historial desplegado
let gastoPago = null;            // gasto al que se está abonando

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(metodo, url, datos) {
  const resp = await fetch(url, {
    method: metodo,
    headers: datos ? { "Content-Type": "application/json" } : {},
    body: datos ? JSON.stringify(datos) : undefined,
  });
  const cuerpo = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(cuerpo.error || `Error ${resp.status}`);
  return cuerpo;
}

function aviso(texto, esError = false) {
  const el = $("#aviso");
  el.textContent = texto;
  el.className = "aviso" + (esError ? " error-aviso" : "");
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (el.hidden = true), 3000);
}

// ---------------------------------------------------------------------------
// Tiempo real (Server-Sent Events)
// ---------------------------------------------------------------------------
function conectar() {
  const fuente = new EventSource("/api/eventos");
  const estadoCon = $("#conexion");
  fuente.addEventListener("estado", (e) => aplicarEstado(JSON.parse(e.data)));
  fuente.onopen = () => { estadoCon.textContent = "● En vivo"; estadoCon.className = "conexion on"; };
  fuente.onerror = () => { estadoCon.textContent = "● Reconectando…"; estadoCon.className = "conexion off"; };
}

function aplicarEstado(estado) {
  gastos = estado.gastos;
  pintarResumen(estado.resumen);
  pintarFiltros();
  pintarLista();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function pintarResumen(r) {
  $("#r-total").textContent = fmt(r.total);
  $("#r-pagado").textContent = fmt(r.pagado);
  $("#r-saldo").textContent = fmt(r.saldo);
  $("#r-pendientes").textContent = `${r.num_pendientes} de ${r.num_gastos}`;
  $("#r-vencidos").textContent = r.num_vencidos ? `${r.num_vencidos} vencido(s)` : "";
  const pct = r.total ? (r.pagado / r.total) * 100 : 0;
  $("#r-barra").style.width = pct + "%";
  $("#r-porcentaje").textContent = r.total ? `${pct.toFixed(1)} % pagado` : "";

  const cats = Object.entries(r.por_categoria);
  $("#panel-categorias").hidden = cats.length < 2;
  $("#categorias-resumen").innerHTML = cats.map(([nombre, c]) => {
    const p = c.total ? (c.pagado / c.total) * 100 : 0;
    return `<div class="cat-fila"><span>${esc(nombre)}</span>
      <div class="progreso"><div style="width:${p}%"></div></div>
      <span class="num">${fmt(c.saldo)} pendiente de ${fmt(c.total)}</span></div>`;
  }).join("");
}

function pintarFiltros() {
  const cats = [...new Set(gastos.map((g) => g.categoria))].sort();
  $("#categorias").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  const sel = $("#filtro-categoria");
  const actual = sel.value;
  sel.innerHTML = `<option value="">Todas las categorías</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = cats.includes(actual) ? actual : "";
}

function filtrados() {
  const q = $("#buscar").value.trim().toLowerCase();
  const est = $("#filtro-estado").value;
  const cat = $("#filtro-categoria").value;
  return gastos.filter((g) => {
    if (cat && g.categoria !== cat) return false;
    if (est === "activos" && g.estado === "pagado") return false;
    if (est === "vencido" && !g.vencido) return false;
    if (["pendiente", "parcial", "pagado"].includes(est) && g.estado !== est) return false;
    if (q && !(`${g.descripcion} ${g.categoria} ${g.notas}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

const ETIQUETAS = { pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };

function pintarLista() {
  const lista = filtrados();
  const nuevasFirmas = new Map();
  const cuerpo = $("#lista");
  cuerpo.innerHTML = lista.map((g) => {
    const firma = `${g.monto}|${g.pagado}|${g.descripcion}|${g.categoria}`;
    nuevasFirmas.set(g.id, firma);
    const cambio = firmas.size && firmas.get(g.id) !== firma;
    const pct = (g.pagado / g.monto) * 100;
    const sub = [esc(g.categoria), fechaCorta(g.fecha)];
    if (g.fecha_vencimiento) {
      sub.push(g.vencido ? `<span class="vencido-tag">venció ${fechaCorta(g.fecha_vencimiento)}</span>`
                         : `vence ${fechaCorta(g.fecha_vencimiento)}`);
    }
    let html = `<tr class="fila-gasto${cambio ? " destello" : ""}" data-id="${g.id}">
      <td><strong>${esc(g.descripcion)}</strong><span class="sub">${sub.join(" · ")}</span></td>
      <td class="num">${fmt(g.monto)}</td>
      <td class="num">${fmt(g.pagado)}</td>
      <td class="num"><strong>${fmt(g.saldo)}</strong></td>
      <td><div class="progreso"><div style="width:${pct}%"></div></div></td>
      <td><span class="estado ${g.estado}">${ETIQUETAS[g.estado]}</span></td>
      <td><div class="botones">
        <button class="chico primario" data-accion="abonar" ${g.saldo <= 0 ? "disabled" : ""}>Abonar</button>
        <button class="chico" data-accion="editar">Editar</button>
        <button class="chico peligro" data-accion="eliminar">✕</button>
      </div></td></tr>`;
    if (abiertos.has(g.id)) {
      html += `<tr class="detalle" data-detalle="${g.id}"><td colspan="7">Cargando abonos…</td></tr>`;
    }
    return html;
  }).join("");
  firmas = nuevasFirmas;
  $("#vacio").hidden = lista.length > 0;
  lista.filter((g) => abiertos.has(g.id)).forEach((g) => cargarHistorial(g));
}

async function cargarHistorial(g) {
  let pagos;
  try {
    pagos = await api("GET", `/api/gastos/${g.id}/pagos`);
  } catch (e) {
    return aviso(e.message, true);
  }
  const celda = document.querySelector(`tr[data-detalle="${g.id}"] td`);
  if (!celda) return;
  const notas = g.notas ? `<p><em>Notas:</em> ${esc(g.notas)}</p>` : "";
  if (!pagos.length) {
    celda.innerHTML = notas + "Sin abonos registrados todavía.";
    return;
  }
  celda.innerHTML = notas + `<table class="historial"><tbody>` + pagos.map((p) => `
    <tr><td>${fechaCorta(p.fecha)}</td><td class="num">${fmt(p.monto)}</td><td>${esc(p.nota)}</td>
    <td><div class="botones"><button class="chico peligro" data-accion="eliminar-pago" data-pago="${p.id}">Eliminar abono</button></div></td></tr>`
  ).join("") + `</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Formulario de gasto (crear / editar)
// ---------------------------------------------------------------------------
const formGasto = $("#form-gasto");

function limpiarFormulario() {
  formGasto.reset();
  formGasto.gasto_id.value = "";
  formGasto.fecha.value = hoy();
  $("#form-titulo").textContent = "Nuevo gasto";
  $("#btn-guardar").textContent = "Agregar gasto";
  $("#btn-cancelar").hidden = true;
}

function editar(g) {
  formGasto.gasto_id.value = g.id;
  formGasto.descripcion.value = g.descripcion;
  formGasto.categoria.value = g.categoria;
  formGasto.monto.value = g.monto.toFixed(2);
  formGasto.fecha.value = g.fecha;
  formGasto.fecha_vencimiento.value = g.fecha_vencimiento || "";
  formGasto.notas.value = g.notas;
  $("#form-titulo").textContent = "Editar gasto";
  $("#btn-guardar").textContent = "Guardar cambios";
  $("#btn-cancelar").hidden = false;
  formGasto.scrollIntoView({ behavior: "smooth", block: "center" });
  formGasto.descripcion.focus();
}

formGasto.addEventListener("submit", async (e) => {
  e.preventDefault();
  const datos = Object.fromEntries(new FormData(formGasto));
  const id = datos.gasto_id;
  delete datos.gasto_id;
  try {
    if (id) {
      await api("PUT", `/api/gastos/${id}`, datos);
      aviso("Gasto actualizado");
    } else {
      await api("POST", "/api/gastos", datos);
      aviso("Gasto agregado");
    }
    limpiarFormulario();
  } catch (err) {
    aviso(err.message, true);
  }
});
$("#btn-cancelar").addEventListener("click", limpiarFormulario);

// ---------------------------------------------------------------------------
// Diálogo de abono
// ---------------------------------------------------------------------------
const dlg = $("#dlg-pago");
const formPago = $("#form-pago");

function abrirPago(g) {
  gastoPago = g;
  formPago.reset();
  formPago.fecha.value = hoy();
  formPago.monto.max = g.saldo.toFixed(2);
  $("#pago-info").innerHTML = `<strong>${esc(g.descripcion)}</strong><br>Saldo pendiente: ${fmt(g.saldo)}`;
  $("#pago-error").textContent = "";
  dlg.showModal();
  formPago.monto.focus();
}

$("#btn-saldo-total").addEventListener("click", () => {
  if (gastoPago) formPago.monto.value = gastoPago.saldo.toFixed(2);
});
$("#btn-cerrar-pago").addEventListener("click", () => dlg.close());

formPago.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", `/api/gastos/${gastoPago.id}/pagos`, Object.fromEntries(new FormData(formPago)));
    dlg.close();
    aviso("Abono registrado");
  } catch (err) {
    $("#pago-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Acciones en la tabla
// ---------------------------------------------------------------------------
$("#lista").addEventListener("click", async (e) => {
  const boton = e.target.closest("button[data-accion]");
  const fila = e.target.closest("tr.fila-gasto");

  if (boton?.dataset.accion === "eliminar-pago") {
    if (!confirm("¿Eliminar este abono?")) return;
    try {
      await api("DELETE", `/api/pagos/${boton.dataset.pago}`);
      aviso("Abono eliminado");
    } catch (err) { aviso(err.message, true); }
    return;
  }
  if (!fila) return;
  const g = gastos.find((x) => x.id === Number(fila.dataset.id));
  if (!g) return;

  if (!boton) {
    // Clic en la fila: mostrar/ocultar historial de abonos
    abiertos.has(g.id) ? abiertos.delete(g.id) : abiertos.add(g.id);
    return pintarLista();
  }
  switch (boton.dataset.accion) {
    case "abonar": return abrirPago(g);
    case "editar": return editar(g);
    case "eliminar":
      if (!confirm(`¿Eliminar "${g.descripcion}" y todos sus abonos?`)) return;
      try {
        await api("DELETE", `/api/gastos/${g.id}`);
        abiertos.delete(g.id);
        aviso("Gasto eliminado");
      } catch (err) { aviso(err.message, true); }
  }
});

["#buscar", "#filtro-estado", "#filtro-categoria"].forEach((s) =>
  $(s).addEventListener("input", pintarLista));

limpiarFormulario();
conectar();
