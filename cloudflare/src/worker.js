// Control de Gastos — Cloudflare Worker + D1
//
// Rutas (todas requieren sesión salvo /api/login):
//   POST   /api/login            {clave}
//   POST   /api/logout
//   GET    /api/version          -> {version}  (barato; los dispositivos lo consultan cada 3 s)
//   GET    /api/estado           -> {estado: {version, gastos: [...con pagos]}}
//   POST   /api/gastos           {descripcion, montoCent, categoria, fecha, vence, notas}
//   PUT    /api/gastos/:id       (mismos campos)
//   DELETE /api/gastos/:id
//   POST   /api/gastos/:id/pagos {montoCent, fecha, nota}
//   DELETE /api/pagos/:id
// Las escrituras responden con el estado completo actualizado.

const COOKIE = "sesion";
const DURACION_SESION = 90 * 24 * 3600; // 90 días, en segundos

class ErrorHttp extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

const json = (datos, status = 200, extra = {}) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });

// ---------------------------------------------------------------------------
// Sesión: cookie firmada con HMAC usando la contraseña como llave, así que
// cambiar la contraseña cierra todas las sesiones abiertas.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function llave(env) {
  return crypto.subtle.importKey("raw", enc.encode("gastos:" + env.APP_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function firmar(env, texto) {
  return hex(await crypto.subtle.sign("HMAC", await llave(env), enc.encode(texto)));
}

async function iguales(a, b) {
  const [ha, hb] = await Promise.all([a, b].map((x) => crypto.subtle.digest("SHA-256", enc.encode(x))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function sesionValida(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m) return false;
  if (Number(m[1]) < Date.now() / 1000) return false;
  return iguales(await firmar(env, m[1]), m[2]);
}

async function cookieSesion(env) {
  const vence = Math.floor(Date.now() / 1000) + DURACION_SESION;
  const valor = `${vence}.${await firmar(env, String(vence))}`;
  return `${COOKIE}=${valor}; Path=/; Max-Age=${DURACION_SESION}; HttpOnly; Secure; SameSite=Strict`;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
function centavos(v, campo) {
  if (!Number.isInteger(v) || v <= 0 || v > 1e13) throw new ErrorHttp(`El ${campo} debe ser mayor que cero.`);
  return v;
}

function fecha(v, campo, requerida = true) {
  if (v == null || v === "") {
    if (requerida) throw new ErrorHttp(`La ${campo} es obligatoria.`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) throw new ErrorHttp(`La ${campo} no es válida.`);
  return v;
}

const texto = (v, max) => String(v ?? "").trim().slice(0, max);

function datosGasto(d) {
  const descripcion = texto(d.descripcion, 200);
  if (!descripcion) throw new ErrorHttp("Escribe una descripción.");
  return {
    descripcion,
    montoCent: centavos(d.montoCent, "monto"),
    categoria: texto(d.categoria, 60) || "General",
    fecha: fecha(d.fecha || new Date().toISOString().slice(0, 10), "fecha"),
    vence: fecha(d.vence, "fecha de vencimiento", false),
    notas: texto(d.notas, 1000),
  };
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
const subirVersion = (db) => db.prepare("UPDATE meta SET valor = valor + 1 WHERE clave = 'version'");

async function version(db) {
  const fila = await db.prepare("SELECT valor FROM meta WHERE clave = 'version'").first();
  return fila ? fila.valor : 0;
}

async function estado(db) {
  const [v, gastos, pagos] = await db.batch([
    db.prepare("SELECT valor FROM meta WHERE clave = 'version'"),
    db.prepare("SELECT id, descripcion, categoria, monto_centavos, fecha, vence, notas, creado FROM gastos ORDER BY fecha DESC, id DESC"),
    db.prepare("SELECT id, gasto_id, monto_centavos, fecha, nota FROM pagos ORDER BY fecha, id"),
  ]);
  const porGasto = new Map();
  for (const p of pagos.results) {
    if (!porGasto.has(p.gasto_id)) porGasto.set(p.gasto_id, []);
    porGasto.get(p.gasto_id).push({ id: p.id, montoCent: p.monto_centavos, fecha: p.fecha, nota: p.nota });
  }
  return {
    version: v.results[0]?.valor ?? 0,
    gastos: gastos.results.map((g) => ({
      id: g.id, descripcion: g.descripcion, categoria: g.categoria, montoCent: g.monto_centavos,
      fecha: g.fecha, vence: g.vence, notas: g.notas, creado: g.creado, pagos: porGasto.get(g.id) || [],
    })),
  };
}

async function saldo(db, gastoId) {
  const fila = await db.prepare(
    `SELECT g.monto_centavos AS total, COALESCE((SELECT SUM(monto_centavos) FROM pagos WHERE gasto_id = g.id), 0) AS pagado
     FROM gastos g WHERE g.id = ?`).bind(gastoId).first();
  if (!fila) throw new ErrorHttp("Este gasto ya no existe.", 404);
  return fila;
}

const fmt = (c) => "Q " + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
async function api(request, env, ruta) {
  const db = env.DB;
  const metodo = request.method;
  const cuerpo = async () => {
    try {
      const d = await request.json();
      if (d && typeof d === "object" && !Array.isArray(d)) return d;
    } catch {}
    throw new ErrorHttp("Datos inválidos.");
  };

  if (!env.APP_PASSWORD) {
    throw new ErrorHttp("Falta configurar la contraseña: ejecuta  npx wrangler secret put APP_PASSWORD", 500);
  }

  if (ruta === "/api/login" && metodo === "POST") {
    const { clave } = await cuerpo();
    if (typeof clave !== "string" || !(await iguales(clave, env.APP_PASSWORD))) {
      await new Promise((r) => setTimeout(r, 800)); // frena intentos repetidos
      throw new ErrorHttp("Contraseña incorrecta.", 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await cookieSesion(env) });
  }

  if (!(await sesionValida(request, env))) throw new ErrorHttp("Inicia sesión.", 401);

  if (ruta === "/api/logout" && metodo === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (ruta === "/api/version" && metodo === "GET") return json({ version: await version(db) });
  if (ruta === "/api/estado" && metodo === "GET") return json({ estado: await estado(db) });

  let m;
  if (ruta === "/api/gastos" && metodo === "POST") {
    const g = datosGasto(await cuerpo());
    await db.batch([
      db.prepare("INSERT INTO gastos (descripcion, categoria, monto_centavos, fecha, vence, notas) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(g.descripcion, g.categoria, g.montoCent, g.fecha, g.vence, g.notas),
      subirVersion(db),
    ]);
    return json({ estado: await estado(db) }, 201);
  }

  if ((m = ruta.match(/^\/api\/gastos\/(\d+)$/))) {
    const id = Number(m[1]);
    if (metodo === "PUT") {
      const g = datosGasto(await cuerpo());
      const { pagado } = await saldo(db, id);
      if (g.montoCent < pagado) throw new ErrorHttp(`El total no puede ser menor a lo ya abonado (${fmt(pagado)}).`);
      await db.batch([
        db.prepare("UPDATE gastos SET descripcion = ?, categoria = ?, monto_centavos = ?, fecha = ?, vence = ?, notas = ? WHERE id = ?")
          .bind(g.descripcion, g.categoria, g.montoCent, g.fecha, g.vence, g.notas, id),
        subirVersion(db),
      ]);
      return json({ estado: await estado(db) });
    }
    if (metodo === "DELETE") {
      const [, borrado] = await db.batch([
        db.prepare("DELETE FROM pagos WHERE gasto_id = ?").bind(id),
        db.prepare("DELETE FROM gastos WHERE id = ?").bind(id),
        subirVersion(db),
      ]);
      if (!borrado.meta.changes) throw new ErrorHttp("Este gasto ya no existe.", 404);
      return json({ estado: await estado(db) });
    }
  }

  if ((m = ruta.match(/^\/api\/gastos\/(\d+)\/pagos$/)) && metodo === "POST") {
    const id = Number(m[1]);
    const d = await cuerpo();
    const monto = centavos(d.montoCent, "abono");
    const f = fecha(d.fecha || new Date().toISOString().slice(0, 10), "fecha");
    // Inserta solo si el abono cabe en el saldo (verificado dentro de la misma sentencia).
    const [ins] = await db.batch([
      db.prepare(
        `INSERT INTO pagos (gasto_id, monto_centavos, fecha, nota)
         SELECT ?1, ?2, ?3, ?4
         WHERE (SELECT g.monto_centavos - COALESCE((SELECT SUM(monto_centavos) FROM pagos WHERE gasto_id = ?1), 0)
                FROM gastos g WHERE g.id = ?1) >= ?2`).bind(id, monto, f, texto(d.nota, 300)),
      subirVersion(db),
    ]);
    if (!ins.meta.changes) {
      const { total, pagado } = await saldo(db, id);
      throw new ErrorHttp(total - pagado <= 0 ? "Este gasto ya está pagado por completo."
        : `El abono supera el saldo pendiente (${fmt(total - pagado)}).`);
    }
    return json({ estado: await estado(db) }, 201);
  }

  if ((m = ruta.match(/^\/api\/pagos\/(\d+)$/)) && metodo === "DELETE") {
    const [borrado] = await db.batch([
      db.prepare("DELETE FROM pagos WHERE id = ?").bind(Number(m[1])),
      subirVersion(db),
    ]);
    if (!borrado.meta.changes) throw new ErrorHttp("Este abono ya no existe.", 404);
    return json({ estado: await estado(db) });
  }

  throw new ErrorHttp("Ruta no encontrada.", 404);
}

export default {
  async fetch(request, env) {
    const ruta = new URL(request.url).pathname.replace(/\/+$/, "");
    if (!ruta.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, ruta);
    } catch (e) {
      if (e instanceof ErrorHttp) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Error interno del servidor." }, 500);
    }
  },
};
