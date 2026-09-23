# Control de Gastos

Programa para registrar gastos/deudas, ir **abonando pagos** y ver el saldo **actualizado en tiempo real**.

- Base de datos **SQLite** (`gastos.db`, se crea sola la primera vez).
- Interfaz web: se abre en el navegador (computadora o celular).
- **Tiempo real**: si tienes la página abierta en varias pestañas o dispositivos, todas se actualizan solas al agregar un gasto o abono.
- **Sin instalar nada**: solo necesita Python 3.9 o superior.

## Cómo usarlo

```bash
python3 app.py
```

Abre <http://localhost:8000>.

Para verlo desde el celular (en la misma red Wi‑Fi):

```bash
python3 app.py --host 0.0.0.0
```

y entra a `http://IP-DE-TU-COMPUTADORA:8000`.

Opciones: `--port 9000` (otro puerto), `--db otra.db` (otro archivo de base de datos).

## Funciones

| Función | Cómo |
|---|---|
| Agregar gasto | Formulario "Nuevo gasto" (descripción, categoría, monto, fecha, vencimiento, notas) |
| Abonar | Botón **Abonar** → monto, fecha y nota. "Pagar saldo completo" rellena el saldo restante |
| Ver historial de abonos | Clic sobre la fila del gasto |
| Corregir un abono | En el historial → **Eliminar abono** |
| Editar / eliminar gasto | Botones **Editar** y **✕** |
| Filtrar | Búsqueda por texto, estado (pendiente, parcial, pagado, vencido) y categoría |
| Resumen | Total, abonado, saldo pendiente, % pagado, vencidos y totales por categoría |

Reglas: un abono no puede superar el saldo pendiente, y el monto de un gasto no puede bajar de lo ya abonado. Los montos se guardan en centavos para evitar errores de redondeo.

La moneda es quetzales (`Q`); para cambiarla, edita `MONEDA` al inicio de `static/app.js`.

## Respaldo

Todos tus datos están en el archivo `gastos.db`. Cópialo para hacer un respaldo.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/gastos` | Lista de gastos con abonado, saldo y estado |
| POST | `/api/gastos` | Crear gasto |
| PUT / DELETE | `/api/gastos/{id}` | Editar / eliminar gasto (borra también sus abonos) |
| GET / POST | `/api/gastos/{id}/pagos` | Ver / registrar abonos |
| DELETE | `/api/pagos/{id}` | Eliminar abono |
| GET | `/api/resumen` | Totales generales y por categoría |
| GET | `/api/eventos` | Flujo de actualizaciones en tiempo real (Server-Sent Events) |

## Pruebas

```bash
python3 -m unittest -v
```
