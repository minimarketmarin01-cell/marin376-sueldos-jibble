// Worker: horas semanales desde Jibble -> JSON limpio para la web app de sueldos.
// Secrets requeridos (wrangler secret put): JIBBLE_CLIENT_ID, JIBBLE_CLIENT_SECRET
// Var opcional: JIBBLE_EMPLOYEE_NAMES = "Nombre Uno,Nombre Dos,Nombre Tres" (filtra a esos 3; si no se define, trae a todos)
//
// Endpoint de horas confirmado con /discover contra la API real (no estaba en la
// doc pública accesible): https://time-tracking.prod.jibble.io/v1/TimeEntries
// Son eventos de marcaje (type: "In" / "Out") con belongsToDate, personId y time
// (UTC). Las horas trabajadas se calculan emparejando cada "In" con su "Out".

const JIBBLE_TOKEN_URL = "https://identity.prod.jibble.io/connect/token";
const JIBBLE_PEOPLE_URL = "https://workspace.prod.jibble.io/v1/People";
const JIBBLE_TIME_ENTRIES_URL = "https://time-tracking.prod.jibble.io/v1/TimeEntries";

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

function odataUrl(base, params) {
  const parts = Object.entries(params).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  );
  return `${base}?${parts.join("&")}`;
}

// Sigue @odata.nextLink hasta juntar todas las páginas (con un tope de seguridad).
async function fetchAllPages(firstUrl, token, maxPages = 20) {
  let url = firstUrl;
  let all = [];
  for (let i = 0; i < maxPages && url; i++) {
    const payload = await jibbleGet(url, token);
    all = all.concat(extractArray(payload));
    url = payload?.["@odata.nextLink"] || null;
  }
  return all;
}

async function getPeopleMap(token) {
  const url = odataUrl(JIBBLE_PEOPLE_URL, { $select: "id,fullName" });
  const people = await fetchAllPages(url, token);
  const map = new Map();
  for (const p of people) {
    const id = p.id ?? p.personId ?? p.memberId;
    const name = p.fullName ?? p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ");
    if (id && name) map.set(id, name);
  }
  return map;
}

async function fetchTimeEntries(token, from, to) {
  const url = odataUrl(JIBBLE_TIME_ENTRIES_URL, {
    $filter: `belongsToDate ge ${from} and belongsToDate le ${to}`,
    $orderby: "personId,time",
    $top: "500",
  });
  return fetchAllPages(url, token);
}

// Fecha calendario (YYYY-MM-DD) en America/Santiago para un instante ISO dado.
function chileLocalDate(isoTime) {
  return CHILE_DATE_FMT.format(new Date(isoTime));
}
const CHILE_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Instante UTC (ms) del primer momento que ya pertenece a un dia distinto de
// `fromTime`, buscando por biseccion entre fromTime y toTime (que se sabe
// caen en dias distintos). Evita asumir un offset fijo (Chile puede tener
// horario de verano).
function findDayBoundary(fromTime, toTime) {
  const startDate = chileLocalDate(fromTime);
  let lo = new Date(fromTime).getTime();
  let hi = new Date(toTime).getTime();
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (chileLocalDate(mid) === startDate) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Reparte la duracion de un tramo entre los dias calendario (Chile) que
// cruza, igual que Jibble divide la jornada a medianoche local.
function splitTramoPorDia(fromTime, toTime) {
  const segments = [];
  let cursor = fromTime;
  let cursorDate = chileLocalDate(cursor);
  const endDate = chileLocalDate(toTime);
  let guard = 0;
  while (cursorDate !== endDate && guard < 10) {
    const boundary = findDayBoundary(cursor, toTime);
    const hrs = (boundary - new Date(cursor).getTime()) / 3600000;
    if (hrs > 0) segments.push({ dia: cursorDate, horas: hrs });
    cursor = new Date(boundary).toISOString();
    cursorDate = chileLocalDate(cursor);
    guard++;
  }
  const hrsLast = (new Date(toTime).getTime() - new Date(cursor).getTime()) / 3600000;
  if (hrsLast > 0) segments.push({ dia: cursorDate, horas: hrsLast });
  return segments;
}

// Empareja cada "In" con el siguiente cierre de tramo por persona y suma la
// duración semanal, repartiendo cada tramo entre los días calendario que
// cruza (igual que Jibble, que divide la jornada a medianoche local) para
// el desglose por día. En datos reales, "StartBreak" cierra el tramo
// trabajado (no el campo breakId, que viene en null); para retomar, Jibble
// reusa el tipo "In" en vez de "EndBreak". Si queda un "In" sin cerrar
// (turno en curso), se cuentan las horas hasta ahora (o hasta el fin del
// rango consultado).
function computeWorkedHours(entries, rangeToISOEnd) {
  const byPerson = new Map();
  for (const e of entries) {
    if (!e.personId || !e.time || !e.type) continue;
    if (!byPerson.has(e.personId)) byPerson.set(e.personId, []);
    byPerson.get(e.personId).push(e);
  }

  const totals = new Map(); // personId -> { total, porDia: Map(fecha -> horas) }
  const now = Date.now();
  const rangeEnd = Math.min(now, new Date(rangeToISOEnd).getTime());

  for (const [personId, list] of byPerson) {
    list.sort((a, b) => new Date(a.time) - new Date(b.time));
    let pendingIn = null; // { time, belongsToDate }
    let total = 0;
    const porDia = new Map();
    const eventosPorDia = new Map(); // fecha -> [{ tipo, hora }] (todos los marcajes crudos del dia)

    const addTramo = (fromEntry, toTime) => {
      total += (new Date(toTime) - new Date(fromEntry.time)) / 3600000;
      for (const seg of splitTramoPorDia(fromEntry.time, toTime)) {
        porDia.set(seg.dia, (porDia.get(seg.dia) || 0) + seg.horas);
      }
    };

    for (const e of list) {
      const dia = e.belongsToDate || e.time.slice(0, 10);
      if (!eventosPorDia.has(dia)) eventosPorDia.set(dia, []);
      eventosPorDia.get(dia).push({ tipo: e.type, hora: e.time });

      if (e.type === "In") {
        if (pendingIn) {
          // Doble "In" sin cierre intermedio: no se descarta el tramo
          // anterior, se cierra en este mismo instante.
          addTramo(pendingIn, e.time);
        }
        pendingIn = { time: e.time, belongsToDate: e.belongsToDate };
      } else if ((e.type === "Out" || e.type === "StartBreak") && pendingIn) {
        addTramo(pendingIn, e.time);
        pendingIn = null;
      }
      // Otros tipos (p.ej. EndBreak) no abren ni cierran tramo.
    }

    if (pendingIn && rangeEnd > new Date(pendingIn.time).getTime()) {
      addTramo(pendingIn, rangeEnd);
    }

    totals.set(personId, { total, porDia, eventosPorDia });
  }

  return totals;
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
  const [peopleMap, entries] = await Promise.all([
    getPeopleMap(token),
    fetchTimeEntries(token, from, to),
  ]);

  const totals = computeWorkedHours(entries, `${to}T23:59:59Z`);

  const allowedNames = (env.JIBBLE_EMPLOYEE_NAMES || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  const result = [];
  for (const [personId, { total, porDia, eventosPorDia }] of totals) {
    const nombre = peopleMap.get(personId) || personId;
    if (allowedNames.length && !allowedNames.includes(nombre)) continue;
    result.push({
      nombre,
      horasTrabajadas: Math.round(total * 100) / 100,
      porDia: roundPorDia(porDia),
      marcajesPorDia: eventosPorDiaToObj(eventosPorDia),
    });
  }

  return { from, to, empleados: result };
}

function roundPorDia(porDiaMap) {
  const out = {};
  for (const [fecha, horas] of porDiaMap) out[fecha] = Math.round(horas * 100) / 100;
  return out;
}

function eventosPorDiaToObj(eventosPorDiaMap) {
  const out = {};
  for (const [fecha, eventos] of eventosPorDiaMap) out[fecha] = eventos;
  return out;
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
        // Devuelve la respuesta cruda de Jibble para verificar el cálculo.
        const params = url.searchParams;
        const { from: defaultFrom, to: defaultTo } = currentWeekRangeChile();
        const from = params.get("from") || defaultFrom;
        const to = params.get("to") || defaultTo;
        const token = await getJibbleToken(env);
        const [peopleMap, entries] = await Promise.all([
          getPeopleMap(token),
          fetchTimeEntries(token, from, to),
        ]);
        const totals = computeWorkedHours(entries, `${to}T23:59:59Z`);
        const empleados = [...totals].map(([personId, { total, porDia }]) => ({
          personId,
          nombre: peopleMap.get(personId) || personId,
          horasTrabajadas: Math.round(total * 100) / 100,
          porDia: roundPorDia(porDia),
        }));
        return json({ from, to, empleados, cantidadDeMarcajes: entries.length, marcajesCrudos: entries.slice(0, 20) });
      }

      return json({ error: "Ruta no encontrada. Usa GET /horas-semana o GET /debug." }, 404);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || "Error interno" }, status);
    }
  },
};
