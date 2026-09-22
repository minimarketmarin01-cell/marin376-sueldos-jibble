// Worker: horas semanales desde Jibble -> JSON limpio para la web app de sueldos.
// Secrets requeridos (wrangler secret put): JIBBLE_CLIENT_ID, JIBBLE_CLIENT_SECRET
// Var opcional: JIBBLE_EMPLOYEE_NAMES = "Nombre Uno,Nombre Dos,Nombre Tres" (filtra a esos 3; si no se define, trae a todos)

const JIBBLE_TOKEN_URL = "https://identity.prod.jibble.io/connect/token";
const JIBBLE_PEOPLE_URL = "https://workspace.prod.jibble.io/v1/People";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Cache de token en memoria del isolate (evita pedir token en cada request).
let cachedToken = null;
let cachedTokenExpiresAt = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function getJibbleToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.JIBBLE_CLIENT_ID,
    client_secret: env.JIBBLE_CLIENT_SECRET,
  });

  const res = await fetch(JIBBLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `AUTH_FAILED: Jibble rechazó las credenciales (HTTP ${res.status}). ${detail}`.slice(0, 500)
    );
    err.status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresca 60s antes de que expire.
  cachedTokenExpiresAt = now + Math.max((data.expires_in || 3600) - 60, 30) * 1000;
  return cachedToken;
}

async function jibbleGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Jibble respondió HTTP ${res.status} en ${url}. ${detail}`.slice(0, 500));
    err.status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw err;
  }
  return res.json();
}

// Distintas APIs devuelven la lista en formas distintas (OData .value, .data, array plano).
function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.value)) return payload.value;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return [];
}

async function getPeopleMap(token) {
  const payload = await jibbleGet(`${JIBBLE_PEOPLE_URL}?$select=id,fullName`, token);
  const people = extractArray(payload);
  const map = new Map();
  for (const p of people) {
    const id = p.id ?? p.personId ?? p.memberId;
    const name = p.fullName ?? p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ");
    if (id && name) map.set(id, name);
  }
  return map;
}

// El campo con las horas trabajadas no está confirmado contra la doc oficial
// (docs.api.jibble.io no fue accesible al construir este Worker). Se prueba
// una lista de nombres de campo comunes; /debug expone la respuesta cruda
// de Jibble para ajustar esto con datos reales una vez conectadas las credenciales.
const HOURS_FIELD_CANDIDATES = [
  "totalTime",
  "totalHours",
  "totalDuration",
  "duration",
  "hours",
  "workedHours",
  "totalWorkedTime",
];

function secondsToHours(value) {
  // Heurística: si el número es grande, probablemente son segundos, no horas.
  return value > 200 ? value / 3600 : value;
}

function extractHours(entry) {
  for (const field of HOURS_FIELD_CANDIDATES) {
    const raw = entry[field];
    if (typeof raw === "number") return secondsToHours(raw);
    if (typeof raw === "string" && !isNaN(Number(raw))) return secondsToHours(Number(raw));
  }
  return 0;
}

async function fetchHoursRaw(token, from, to) {
  // Intento 1: TimeTrackingReport con from/to simples.
  const attempts = [
    `https://time-tracking.prod.jibble.io/v1/TimeTrackingReport?from=${from}&to=${to}`,
    `https://time-tracking.prod.jibble.io/v1/Timesheets?$filter=date ge ${from} and date le ${to}`,
  ];

  let lastError;
  for (const url of attempts) {
    try {
      return { url, payload: await jibbleGet(url, token) };
    } catch (e) {
      lastError = e;
      if (e.status === 401 || e.status === 403) throw e; // credenciales mal, no seguir probando
    }
  }
  throw lastError;
}

function currentWeekRangeChile() {
  // Lunes a domingo, hora de Santiago (UTC-3/UTC-4 según horario de verano).
  const now = new Date();
  const chileNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Santiago" }));
  const day = chileNow.getDay(); // 0=domingo
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(chileNow);
  monday.setDate(chileNow.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(monday), to: fmt(sunday) };
}

async function handleHorasSemana(url, env) {
  const params = url.searchParams;
  const { from: defaultFrom, to: defaultTo } = currentWeekRangeChile();
  const from = params.get("from") || defaultFrom;
  const to = params.get("to") || defaultTo;

  const token = await getJibbleToken(env);
  const [peopleMap, hoursRes] = await Promise.all([
    getPeopleMap(token),
    fetchHoursRaw(token, from, to),
  ]);

  const entries = extractArray(hoursRes.payload);
  const totals = new Map(); // personId -> horas acumuladas

  for (const entry of entries) {
    const personId = entry.personId ?? entry.memberId ?? entry.id ?? entry.person?.id;
    if (!personId) continue;
    const hours = extractHours(entry);
    totals.set(personId, (totals.get(personId) || 0) + hours);
  }

  const allowedNames = (env.JIBBLE_EMPLOYEE_NAMES || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  const result = [];
  for (const [personId, horas] of totals) {
    const nombre = peopleMap.get(personId) || personId;
    if (allowedNames.length && !allowedNames.includes(nombre)) continue;
    result.push({ nombre, horasTrabajadas: Math.round(horas * 100) / 100 });
  }

  return { from, to, empleados: result };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/horas-semana" && request.method === "GET") {
        const data = await handleHorasSemana(url, env);
        return json(data);
      }

      if (url.pathname === "/debug" && request.method === "GET") {
        // Devuelve la respuesta cruda de Jibble para verificar nombres de campo reales.
        const params = url.searchParams;
        const { from: defaultFrom, to: defaultTo } = currentWeekRangeChile();
        const from = params.get("from") || defaultFrom;
        const to = params.get("to") || defaultTo;
        const token = await getJibbleToken(env);
        const people = await jibbleGet(`${JIBBLE_PEOPLE_URL}?$select=id,fullName`, token);
        const hours = await fetchHoursRaw(token, from, to);
        return json({ from, to, people, horasEndpointUsado: hours.url, horasRaw: hours.payload });
      }

      return json({ error: "Ruta no encontrada. Usa GET /horas-semana o GET /debug." }, 404);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || "Error interno" }, status);
    }
  },
};
