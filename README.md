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

## 2. Verificar el schema real de Jibble

No se pudo confirmar contra `docs.api.jibble.io` el nombre exacto del campo de horas trabajadas (bloqueo de red al construir esto). El Worker ya intenta los endpoints `TimeTrackingReport` y `Timesheets` con varios nombres de campo comunes (`totalTime`, `duration`, `hours`, etc.), pero **hay que confirmarlo con datos reales**:

```
curl "https://TU-WORKER.workers.dev/debug"
```

Esto devuelve la respuesta cruda de Jibble (personas + horas). Si `empleados` sale vacío o con horas en 0 desde `/horas-semana`, comparte la salida de `/debug` para ajustar el nombre de campo correcto en `worker.js` (función `extractHours`).

## 3. Configurar la web app

Abre `app.html` (o el Artifact publicado) → botón de engranaje → **Configuración** → pega la URL del Worker del paso 1. Los sueldos mensuales de cada trabajador se ingresan directo en su tarjeta y quedan guardados en el navegador (no se envían a ningún servidor).

## Archivos

- `worker.js` — Cloudflare Worker: OAuth2 contra Jibble + endpoint `/horas-semana` y `/debug`.
- `wrangler.toml` — configuración de despliegue.
- `app.html` — web app mobile-first (también publicada como Artifact).
