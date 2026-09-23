# Publicar en Cloudflare

Resultado: tu programa en una dirección propia, por ejemplo
`https://gastos.TU-USUARIO.workers.dev`, protegida con contraseña, usable desde la PC y el celular en cualquier lugar.
Todo cabe en el plan **gratuito** de Cloudflare (Workers + base de datos D1).

## Lo que necesitas (una sola vez)

1. Tu cuenta de Cloudflare.
2. **Node.js** instalado en tu PC: descarga la versión "LTS" de <https://nodejs.org> e instálala (siguiente, siguiente…).
3. Este proyecto en tu PC: en GitHub abre el repositorio, cambia a la rama `claude/busy-gauss-7a4a3u`,
   botón verde **Code → Download ZIP**, y descomprímelo.

## Pasos

Abre una terminal **dentro de la carpeta `cloudflare`** del proyecto
(Windows: abre la carpeta en el Explorador, escribe `cmd` en la barra de dirección y Enter).

```bash
# 1. Conectar con tu cuenta (se abre el navegador; pulsa "Allow")
npx wrangler login

# 2. Crear la base de datos
npx wrangler d1 create gastos
```

El paso 2 muestra un bloque con `database_id = "xxxxxxxx-...."`.
Abre `wrangler.toml` con el Bloc de notas y reemplaza `PEGA-AQUI-EL-DATABASE-ID` por ese valor. Guarda.

```bash
# 3. Crear las tablas
npx wrangler d1 migrations apply gastos --remote

# 4. Publicar
npx wrangler deploy

# 5. Poner tu contraseña (te la pide; escríbela y Enter)
npx wrangler secret put APP_PASSWORD
```

El paso 4 imprime tu dirección: `https://gastos.TU-USUARIO.workers.dev`. Ábrela, escribe tu contraseña y listo.

## En el celular

Abre la dirección en Chrome o Safari, entra con tu contraseña y usa
**"Agregar a pantalla de inicio"** para tenerla como una app. La sesión dura 90 días.

## Dominio propio (opcional)

Si tienes un dominio administrado en Cloudflare: panel de Cloudflare → **Workers & Pages → gastos →
Settings → Domains & Routes → Add → Custom domain**, y escribe por ejemplo `gastos.tudominio.com`.

## Mantenimiento

| Quiero… | Comando (en la carpeta `cloudflare`) |
|---|---|
| Publicar cambios del programa | `npx wrangler deploy` |
| Cambiar la contraseña (cierra todas las sesiones) | `npx wrangler secret put APP_PASSWORD` |
| Respaldo completo de la base de datos | `npx wrangler d1 export gastos --remote --output respaldo.sql` |

También puedes bajar un CSV desde el botón **Descargar respaldo** de la página.

## Probar en tu PC antes de publicar (opcional)

```bash
echo APP_PASSWORD="prueba" > .dev.vars
npx wrangler d1 migrations apply gastos --local
npx wrangler dev
```
y abre <http://localhost:8787>.
