#!/usr/bin/env python3
"""Control de Gastos y Abonos.

Servidor web sin dependencias externas (solo biblioteca estándar de Python):
  - Base de datos SQLite (gastos.db)
  - API JSON para gastos y pagos (abonos)
  - Actualización en tiempo real vía Server-Sent Events (SSE)

Uso:
    python3 app.py            # http://localhost:8000
    python3 app.py --port 9000 --db otra.db
"""

import argparse
import json
import os
import re
import sqlite3
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

SCHEMA = """
CREATE TABLE IF NOT EXISTS gastos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    descripcion       TEXT    NOT NULL,
    categoria         TEXT    NOT NULL DEFAULT 'General',
    monto_centavos    INTEGER NOT NULL CHECK (monto_centavos > 0),
    fecha             TEXT    NOT NULL,
    fecha_vencimiento TEXT,
    notas             TEXT    NOT NULL DEFAULT '',
    creado            TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS pagos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    gasto_id       INTEGER NOT NULL REFERENCES gastos(id) ON DELETE CASCADE,
    monto_centavos INTEGER NOT NULL CHECK (monto_centavos > 0),
    fecha          TEXT    NOT NULL,
    nota           TEXT    NOT NULL DEFAULT '',
    creado         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_gasto ON pagos(gasto_id);
"""

GASTOS_QUERY = """
SELECT g.id, g.descripcion, g.categoria, g.monto_centavos, g.fecha,
       g.fecha_vencimiento, g.notas, g.creado,
       COALESCE(SUM(p.monto_centavos), 0) AS pagado_centavos,
       COUNT(p.id) AS num_pagos
FROM gastos g
LEFT JOIN pagos p ON p.gasto_id = g.id
GROUP BY g.id
ORDER BY g.fecha DESC, g.id DESC
"""


class ErrorValidacion(Exception):
    def __init__(self, mensaje, status=400):
        super().__init__(mensaje)
        self.status = status


# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------

class BaseDatos:
    def __init__(self, ruta):
        self.ruta = ruta
        self.lock = threading.Lock()
        with self._conectar() as con:
            con.executescript(SCHEMA)

    def _conectar(self):
        con = sqlite3.connect(self.ruta)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        return con

    def consultar(self, sql, params=()):
        con = self._conectar()
        try:
            return [dict(r) for r in con.execute(sql, params).fetchall()]
        finally:
            con.close()

    def escribir(self, fn):
        """Ejecuta fn(con) dentro de una transacción serializada."""
        with self.lock:
            con = self._conectar()
            try:
                with con:
                    return fn(con)
            finally:
                con.close()


# ---------------------------------------------------------------------------
# Notificaciones en tiempo real
# ---------------------------------------------------------------------------

class Notificador:
    """Cada escritura incrementa la versión y despierta a los clientes SSE."""

    def __init__(self):
        self.version = 0
        self.cond = threading.Condition()

    def notificar(self):
        with self.cond:
            self.version += 1
            self.cond.notify_all()

    def esperar(self, version_actual, timeout=15):
        with self.cond:
            self.cond.wait_for(lambda: self.version != version_actual, timeout)
            return self.version


# ---------------------------------------------------------------------------
# Validación y conversión
# ---------------------------------------------------------------------------

def a_centavos(valor, campo="monto"):
    try:
        texto = str(valor).strip().replace(",", "")
        if not re.fullmatch(r"\d+(\.\d{1,2})?", texto):
            raise ValueError
        entero, _, dec = texto.partition(".")
        centavos = int(entero) * 100 + int((dec + "00")[:2])
    except (ValueError, TypeError):
        raise ErrorValidacion(f"El {campo} debe ser un número positivo con hasta 2 decimales.")
    if centavos <= 0:
        raise ErrorValidacion(f"El {campo} debe ser mayor que cero.")
    return centavos


def validar_fecha(valor, campo, requerido=True):
    if valor in (None, ""):
        if requerido:
            raise ErrorValidacion(f"La {campo} es obligatoria.")
        return None
    try:
        return date.fromisoformat(str(valor)).isoformat()
    except ValueError:
        raise ErrorValidacion(f"La {campo} no es válida (formato AAAA-MM-DD).")


def texto(datos, campo, requerido=False, defecto="", max_len=500):
    valor = str(datos.get(campo) or "").strip()
    if requerido and not valor:
        raise ErrorValidacion(f"El campo '{campo}' es obligatorio.")
    return (valor or defecto)[:max_len]


def serializar_gasto(g):
    total = g["monto_centavos"]
    pagado = g["pagado_centavos"]
    saldo = total - pagado
    if pagado <= 0:
        estado = "pendiente"
    elif saldo <= 0:
        estado = "pagado"
    else:
        estado = "parcial"
    vencido = bool(
        g["fecha_vencimiento"]
        and saldo > 0
        and g["fecha_vencimiento"] < date.today().isoformat()
    )
    return {
        "id": g["id"],
        "descripcion": g["descripcion"],
        "categoria": g["categoria"],
        "fecha": g["fecha"],
        "fecha_vencimiento": g["fecha_vencimiento"],
        "notas": g["notas"],
        "creado": g["creado"],
        "monto": total / 100,
        "pagado": pagado / 100,
        "saldo": saldo / 100,
        "num_pagos": g["num_pagos"],
        "estado": estado,
        "vencido": vencido,
    }


# ---------------------------------------------------------------------------
# Lógica de negocio
# ---------------------------------------------------------------------------

class Servicio:
    def __init__(self, db, notificador):
        self.db = db
        self.notificador = notificador

    # -- lectura --
    def listar_gastos(self):
        return [serializar_gasto(g) for g in self.db.consultar(GASTOS_QUERY)]

    def obtener_gasto(self, gasto_id):
        filas = self.db.consultar(
            GASTOS_QUERY.replace("GROUP BY", "WHERE g.id = ? GROUP BY"), (gasto_id,)
        )
        if not filas:
            raise ErrorValidacion("Gasto no encontrado.", 404)
        return serializar_gasto(filas[0])

    def listar_pagos(self, gasto_id=None):
        sql = """SELECT p.id, p.gasto_id, p.monto_centavos, p.fecha, p.nota, p.creado,
                        g.descripcion AS gasto
                 FROM pagos p JOIN gastos g ON g.id = p.gasto_id"""
        params = ()
        if gasto_id is not None:
            sql += " WHERE p.gasto_id = ?"
            params = (gasto_id,)
        sql += " ORDER BY p.fecha DESC, p.id DESC"
        return [
            {**{k: v for k, v in p.items() if k != "monto_centavos"},
             "monto": p["monto_centavos"] / 100}
            for p in self.db.consultar(sql, params)
        ]

    def resumen(self):
        gastos = self.listar_gastos()
        total = sum(g["monto"] for g in gastos)
        pagado = sum(g["pagado"] for g in gastos)
        por_categoria = {}
        for g in gastos:
            c = por_categoria.setdefault(g["categoria"], {"total": 0, "pagado": 0, "saldo": 0})
            c["total"] += g["monto"]
            c["pagado"] += g["pagado"]
            c["saldo"] += g["saldo"]
        return {
            "total": round(total, 2),
            "pagado": round(pagado, 2),
            "saldo": round(total - pagado, 2),
            "num_gastos": len(gastos),
            "num_pendientes": sum(1 for g in gastos if g["estado"] != "pagado"),
            "num_vencidos": sum(1 for g in gastos if g["vencido"]),
            "por_categoria": {k: {kk: round(vv, 2) for kk, vv in v.items()}
                              for k, v in sorted(por_categoria.items())},
        }

    def estado(self):
        return {
            "version": self.notificador.version,
            "gastos": self.listar_gastos(),
            "resumen": self.resumen(),
        }

    # -- escritura --
    def _datos_gasto(self, datos):
        return {
            "descripcion": texto(datos, "descripcion", requerido=True, max_len=200),
            "categoria": texto(datos, "categoria", defecto="General", max_len=60),
            "monto_centavos": a_centavos(datos.get("monto")),
            "fecha": validar_fecha(datos.get("fecha") or date.today().isoformat(), "fecha"),
            "fecha_vencimiento": validar_fecha(datos.get("fecha_vencimiento"),
                                               "fecha de vencimiento", requerido=False),
            "notas": texto(datos, "notas", max_len=1000),
        }

    def crear_gasto(self, datos):
        d = self._datos_gasto(datos)
        gasto_id = self.db.escribir(lambda con: con.execute(
            """INSERT INTO gastos (descripcion, categoria, monto_centavos, fecha,
                                   fecha_vencimiento, notas)
               VALUES (:descripcion, :categoria, :monto_centavos, :fecha,
                       :fecha_vencimiento, :notas)""", d).lastrowid)
        self.notificador.notificar()
        return self.obtener_gasto(gasto_id)

    def actualizar_gasto(self, gasto_id, datos):
        d = self._datos_gasto(datos)

        def tx(con):
            fila = con.execute(
                "SELECT COALESCE(SUM(monto_centavos), 0) FROM pagos WHERE gasto_id = ?",
                (gasto_id,)).fetchone()
            if not con.execute("SELECT 1 FROM gastos WHERE id = ?", (gasto_id,)).fetchone():
                raise ErrorValidacion("Gasto no encontrado.", 404)
            if d["monto_centavos"] < fila[0]:
                raise ErrorValidacion(
                    f"El monto no puede ser menor a lo ya abonado ({fila[0] / 100:.2f}).")
            con.execute(
                """UPDATE gastos SET descripcion = :descripcion, categoria = :categoria,
                       monto_centavos = :monto_centavos, fecha = :fecha,
                       fecha_vencimiento = :fecha_vencimiento, notas = :notas
                   WHERE id = :id""", {**d, "id": gasto_id})

        self.db.escribir(tx)
        self.notificador.notificar()
        return self.obtener_gasto(gasto_id)

    def eliminar_gasto(self, gasto_id):
        filas = self.db.escribir(lambda con: con.execute(
            "DELETE FROM gastos WHERE id = ?", (gasto_id,)).rowcount)
        if not filas:
            raise ErrorValidacion("Gasto no encontrado.", 404)
        self.notificador.notificar()
        return {"ok": True}

    def registrar_pago(self, gasto_id, datos):
        monto = a_centavos(datos.get("monto"), "abono")
        fecha = validar_fecha(datos.get("fecha") or date.today().isoformat(), "fecha")
        nota = texto(datos, "nota", max_len=300)

        def tx(con):
            g = con.execute(
                """SELECT g.monto_centavos - COALESCE(SUM(p.monto_centavos), 0)
                   FROM gastos g LEFT JOIN pagos p ON p.gasto_id = g.id
                   WHERE g.id = ? GROUP BY g.id""", (gasto_id,)).fetchone()
            if g is None:
                raise ErrorValidacion("Gasto no encontrado.", 404)
            saldo = g[0]
            if saldo <= 0:
                raise ErrorValidacion("Este gasto ya está pagado por completo.")
            if monto > saldo:
                raise ErrorValidacion(
                    f"El abono ({monto / 100:.2f}) supera el saldo pendiente ({saldo / 100:.2f}).")
            return con.execute(
                "INSERT INTO pagos (gasto_id, monto_centavos, fecha, nota) VALUES (?, ?, ?, ?)",
                (gasto_id, monto, fecha, nota)).lastrowid

        pago_id = self.db.escribir(tx)
        self.notificador.notificar()
        return {"id": pago_id, "gasto": self.obtener_gasto(gasto_id)}

    def eliminar_pago(self, pago_id):
        filas = self.db.escribir(lambda con: con.execute(
            "DELETE FROM pagos WHERE id = ?", (pago_id,)).rowcount)
        if not filas:
            raise ErrorValidacion("Pago no encontrado.", 404)
        self.notificador.notificar()
        return {"ok": True}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

TIPOS = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


def crear_handler(servicio):
    rutas = [
        ("GET", r"/api/estado", lambda h, m: servicio.estado()),
        ("GET", r"/api/gastos", lambda h, m: servicio.listar_gastos()),
        ("POST", r"/api/gastos", lambda h, m: servicio.crear_gasto(h.json())),
        ("GET", r"/api/gastos/(\d+)", lambda h, m: servicio.obtener_gasto(int(m[1]))),
        ("PUT", r"/api/gastos/(\d+)", lambda h, m: servicio.actualizar_gasto(int(m[1]), h.json())),
        ("DELETE", r"/api/gastos/(\d+)", lambda h, m: servicio.eliminar_gasto(int(m[1]))),
        ("GET", r"/api/gastos/(\d+)/pagos", lambda h, m: servicio.listar_pagos(int(m[1]))),
        ("POST", r"/api/gastos/(\d+)/pagos",
         lambda h, m: servicio.registrar_pago(int(m[1]), h.json())),
        ("GET", r"/api/pagos", lambda h, m: servicio.listar_pagos()),
        ("DELETE", r"/api/pagos/(\d+)", lambda h, m: servicio.eliminar_pago(int(m[1]))),
        ("GET", r"/api/resumen", lambda h, m: servicio.resumen()),
    ]

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass  # silencioso

        def json(self):
            largo = int(self.headers.get("Content-Length") or 0)
            try:
                datos = json.loads(self.rfile.read(largo) or b"{}")
            except json.JSONDecodeError:
                raise ErrorValidacion("JSON inválido.")
            if not isinstance(datos, dict):
                raise ErrorValidacion("Se esperaba un objeto JSON.")
            return datos

        def responder(self, status, cuerpo, tipo="application/json; charset=utf-8"):
            if not isinstance(cuerpo, bytes):
                cuerpo = json.dumps(cuerpo, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(cuerpo)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(cuerpo)

        def despachar(self, metodo):
            ruta = urlparse(self.path).path.rstrip("/") or "/"
            if metodo == "GET" and ruta == "/api/eventos":
                return self.eventos()
            if not ruta.startswith("/api/"):
                if metodo == "GET":
                    return self.estatico(ruta)
                return self.responder(405, {"error": "Método no permitido."})
            for m, patron, fn in rutas:
                coincide = re.fullmatch(patron, ruta)
                if coincide and m == metodo:
                    try:
                        status = 201 if metodo == "POST" else 200
                        return self.responder(status, fn(self, coincide))
                    except ErrorValidacion as e:
                        return self.responder(e.status, {"error": str(e)})
                    except Exception as e:  # noqa: BLE001
                        return self.responder(500, {"error": f"Error interno: {e}"})
            self.responder(404, {"error": "Ruta no encontrada."})

        def estatico(self, ruta):
            nombre = "index.html" if ruta == "/" else ruta.lstrip("/")
            archivo = os.path.realpath(os.path.join(STATIC_DIR, nombre))
            if not archivo.startswith(STATIC_DIR + os.sep) or not os.path.isfile(archivo):
                return self.responder(404, b"No encontrado", "text/plain; charset=utf-8")
            with open(archivo, "rb") as f:
                ext = os.path.splitext(archivo)[1]
                self.responder(200, f.read(), TIPOS.get(ext, "application/octet-stream"))

        def eventos(self):
            """Server-Sent Events: avisa al navegador cada vez que cambian los datos."""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.close_connection = True
            version = -1  # fuerza el envío del estado completo al conectar
            try:
                while True:
                    if version != servicio.notificador.version:
                        version = servicio.notificador.version
                        datos = json.dumps(servicio.estado(), ensure_ascii=False)
                        self.wfile.write(f"event: estado\ndata: {datos}\n\n".encode())
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    servicio.notificador.esperar(version)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        def do_GET(self):
            self.despachar("GET")

        def do_POST(self):
            self.despachar("POST")

        def do_PUT(self):
            self.despachar("PUT")

        def do_DELETE(self):
            self.despachar("DELETE")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Control de Gastos y Abonos")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Usa 0.0.0.0 para acceder desde otros dispositivos de tu red")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=os.path.join(BASE_DIR, "gastos.db"))
    args = parser.parse_args()

    servicio = Servicio(BaseDatos(args.db), Notificador())
    servidor = ThreadingHTTPServer((args.host, args.port), crear_handler(servicio))
    servidor.daemon_threads = True
    print(f"Control de Gastos corriendo en http://{args.host}:{args.port}")
    print(f"Base de datos: {args.db}")
    print("Presiona Ctrl+C para detener.")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")


if __name__ == "__main__":
    main()
