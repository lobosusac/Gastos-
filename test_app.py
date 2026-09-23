"""Pruebas de la API.  Ejecutar con:  python3 -m unittest -v"""

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from app import BaseDatos, Notificador, Servicio, a_centavos, ErrorValidacion, crear_handler


class TestCentavos(unittest.TestCase):
    def test_conversion(self):
        self.assertEqual(a_centavos("10"), 1000)
        self.assertEqual(a_centavos("10.5"), 1050)
        self.assertEqual(a_centavos("0.01"), 1)
        self.assertEqual(a_centavos(1234.56), 123456)
        self.assertEqual(a_centavos("1,500.25"), 150025)

    def test_invalidos(self):
        for v in ("", "abc", "-5", "0", "1.234", None):
            with self.assertRaises(ErrorValidacion):
                a_centavos(v)


class TestAPI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        servicio = Servicio(BaseDatos(os.path.join(self.tmp.name, "t.db")), Notificador())
        self.servicio = servicio
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), crear_handler(servicio))
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_port}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def req(self, metodo, ruta, datos=None):
        cuerpo = json.dumps(datos).encode() if datos is not None else None
        r = urllib.request.Request(self.base + ruta, data=cuerpo, method=metodo,
                                   headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_flujo_completo(self):
        s, g = self.req("POST", "/api/gastos", {"descripcion": "Préstamo", "categoria": "Deudas",
                                                "monto": "1000", "fecha": "2026-01-01"})
        self.assertEqual(s, 201)
        self.assertEqual(g["estado"], "pendiente")

        s, r = self.req("POST", f"/api/gastos/{g['id']}/pagos", {"monto": "250.50"})
        self.assertEqual(s, 201)
        self.assertEqual(r["gasto"]["saldo"], 749.5)
        self.assertEqual(r["gasto"]["estado"], "parcial")

        # No se puede abonar más del saldo
        s, r = self.req("POST", f"/api/gastos/{g['id']}/pagos", {"monto": "800"})
        self.assertEqual(s, 400)
        self.assertIn("supera", r["error"])

        # No se puede bajar el total por debajo de lo abonado
        s, r = self.req("PUT", f"/api/gastos/{g['id']}", {**g, "monto": "100"})
        self.assertEqual(s, 400)

        s, r = self.req("POST", f"/api/gastos/{g['id']}/pagos", {"monto": "749.50"})
        self.assertEqual(r["gasto"]["estado"], "pagado")

        s, res = self.req("GET", "/api/resumen")
        self.assertEqual(res, {**res, "total": 1000, "pagado": 1000, "saldo": 0, "num_pendientes": 0})

        s, pagos = self.req("GET", f"/api/gastos/{g['id']}/pagos")
        self.assertEqual(len(pagos), 2)
        self.req("DELETE", f"/api/pagos/{pagos[0]['id']}")
        s, g2 = self.req("GET", f"/api/gastos/{g['id']}")
        self.assertEqual(g2["estado"], "parcial")

        s, _ = self.req("DELETE", f"/api/gastos/{g['id']}")
        self.assertEqual(s, 200)
        s, lista = self.req("GET", "/api/pagos")
        self.assertEqual(lista, [])  # los abonos se borran en cascada

    def test_vencido(self):
        s, g = self.req("POST", "/api/gastos", {"descripcion": "Luz", "monto": "50",
                                                "fecha_vencimiento": "2000-01-01"})
        self.assertTrue(g["vencido"])

    def test_validaciones(self):
        self.assertEqual(self.req("POST", "/api/gastos", {"monto": "5"})[0], 400)
        self.assertEqual(self.req("POST", "/api/gastos", {"descripcion": "x", "monto": "-1"})[0], 400)
        self.assertEqual(self.req("POST", "/api/gastos/999/pagos", {"monto": "1"})[0], 404)
        self.assertEqual(self.req("DELETE", "/api/gastos/999")[0], 404)

    def test_notificacion_tiempo_real(self):
        v = self.servicio.notificador.version
        self.req("POST", "/api/gastos", {"descripcion": "Agua", "monto": "20"})
        self.assertEqual(self.servicio.notificador.esperar(v, timeout=1), v + 1)


if __name__ == "__main__":
    unittest.main()
