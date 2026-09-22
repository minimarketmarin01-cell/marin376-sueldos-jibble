# Planilla semanal (Jibble → sueldos)

## Por qué no está desplegado automáticamente

El client_secret de Jibble nunca debe pasar por este chat ni quedar en el repo. La conexión Cloudflare disponible en esta sesión solo puede leer Workers existentes, no crear ni desplegar nuevos ni fijar secrets — así que el despliegue lo haces tú, una vez, con Wrangler.

## 1. Desplegar el Worker

```
cd sueldos-jibble
npm install -g wrangler   # si no lo tienes
wrangler login
wrangler secret put JIBBLE_CLIENT_ID
wrangler secret put JIBBLE_CLIENT_SECRET
wrangler deploy
```

Al terminar, Wrangler imprime la URL pública, algo como:
`https://marin376-jibble-horas.<tu-subdominio>.workers.dev`

Opcional: en `wrangler.toml`, define `JIBBLE_EMPLOYEE_NAMES` con los 3 nombres exactos como aparecen en Jibble, separados por coma, para filtrar la respuesta a solo esos 3 trabajadores. Si lo dejas vacío, el Worker trae a todos.

## 2. Endpoint de horas (ya verificado)

`docs.api.jibble.io` no fue accesible al construir esto, así que el endpoint se confirmó por prueba directa contra la API (endpoint `/discover`, ya removido del código final). El real es:

`GET https://time-tracking.prod.jibble.io/v1/TimeEntries` — eventos de marcaje individuales (`type: "In"` / `"Out"`, `personId`, `belongsToDate`, `time` en UTC), no horas ya sumadas. El Worker empareja cada "In" con su "Out" para calcular horas trabajadas; los marcajes con `breakId` (descansos) se excluyen del cálculo.

Para revisar el cálculo con datos reales:

```
curl "https://TU-WORKER.workers.dev/debug"
```

Devuelve `empleados` (con horas ya calculadas), `cantidadDeMarcajes` y una muestra cruda (`marcajesCrudos`) para verificar contra lo que se sabe que trabajó cada persona.

## 3. Configurar la web app

Abre `app.html` (o el Artifact publicado) → botón de engranaje → **Configuración** → pega la URL del Worker del paso 1. Los sueldos mensuales de cada trabajador se ingresan directo en su tarjeta y quedan guardados en el navegador (no se envían a ningún servidor).

## Archivos

- `worker.js` — Cloudflare Worker: OAuth2 contra Jibble + endpoint `/horas-semana` y `/debug`.
- `wrangler.toml` — configuración de despliegue.
- `app.html` — web app mobile-first (también publicada como Artifact).
