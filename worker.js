// Worker: horas semanales desde Jibble -> JSON limpio para la web app de sueldos.
// Soporta varias cuentas/organizaciones Jibble (ej. distintos locales), cada
// una con sus propios secrets. La cuenta "1" (o sin sufijo) es la original:
//   JIBBLE_CLIENT_ID, JIBBLE_CLIENT_SECRET, JIBBLE_EMPLOYEE_NAMES (opcional),
//   JIBBLE_CUENTA_NOMBRE (opcional, nombre para mostrar).
// Cuentas adicionales usan sufijo _2, _3, _4:
//   JIBBLE_CLIENT_ID_2, JIBBLE_CLIENT_SECRET_2, JIBBLE_EMPLOYEE_NAMES_2,
//   JIBBLE_CUENTA_NOMBRE_2, etc. Los endpoints reciben ?cuenta=2 (default "1").
// GET /cuentas lista las cuentas con credenciales configuradas.
//
// Endpoint de horas confirmado con /discover contra la API real (no estaba en la
// doc pública accesible): https://time-tracking.prod.jibble.io/v1/TimeEntries
// Son eventos de marcaje (type: "In" / "Out") con belongsToDate, personId y time
// (UTC). Las horas trabajadas se calculan emparejando cada "In" con su "Out".

const JIBBLE_TOKEN_URL = "https://identity.prod.jibble.io/connect/token";
const JIBBLE_PEOPLE_URL = "https://workspace.prod.jibble.io/v1/People";
const JIBBLE_TIME_ENTRIES_URL = "https://time-tracking.prod.jibble.io/v1/TimeEntries";
const CUENTAS_SOPORTADAS = ["1", "2", "3", "4"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Cache de tokens en memoria del isolate, uno por cuenta (evita pedir token
// en cada request).
const cachedTokens = new Map(); // cuenta -> { token, expiresAt }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Credenciales y config de una cuenta Jibble a partir de los secrets/vars
// del Worker, usando el sufijo correspondiente (_2, _3, _4; "1" sin sufijo).
function getCuentaConfig(env, cuenta) {
  const suffix = !cuenta || cuenta === "1" ? "" : `_${cuenta}`;
  return {
    id: cuenta || "1",
    clientId: env[`JIBBLE_CLIENT_ID${suffix}`],
    clientSecret: env[`JIBBLE_CLIENT_SECRET${suffix}`],
    employeeNames: env[`JIBBLE_EMPLOYEE_NAMES${suffix}`] || "",
    nombre: env[`JIBBLE_CUENTA_NOMBRE${suffix}`] || (suffix ? `Cuenta ${cuenta}` : "Cuenta principal"),
  };
}

function listCuentasConfiguradas(env) {
  return CUENTAS_SOPORTADAS.map((id) => getCuentaConfig(env, id)).filter(
    (c) => c.clientId && c.clientSecret
  );
}

async function getJibbleToken(cuentaConfig) {
  const { id: cuenta, clientId, clientSecret } = cuentaConfig;
  const cached = cachedTokens.get(cuenta);
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(JIBBLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `AUTH_FAILED: Jibble rechazó las credenciales de la cuenta "${cuenta}" (HTTP ${res.status}). ${detail}`.slice(0, 500)
    );
    err.status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const token = data.access_token;
  // Refresca 60s antes de que expire.
  cachedTokens.set(cuenta, { token, expiresAt: now + Math.max((data.expires_in || 3600) - 60, 30) * 1000 });
  return token;
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
    let pendingIn = null; // { time, belongsToDate, eventoRef }
    let pendingBreak = null; // { time, belongsToDate, eventoRef }
    let total = 0;
    const porDia = new Map();
    const eventosPorDia = new Map(); // fecha -> [{ tipo, hora, duracionHoras }] (marcajes crudos del dia)

    const addTramo = (fromEntry, toTime) => {
      total += (new Date(toTime) - new Date(fromEntry.time)) / 3600000;
      for (const seg of splitTramoPorDia(fromEntry.time, toTime)) {
        porDia.set(seg.dia, (porDia.get(seg.dia) || 0) + seg.horas);
      }
    };

    // Duracion de un marcaje hasta que cierra (fromTime -> toTime), recortada
    // a medianoche local si el cierre cae en otro dia calendario. Se guarda
    // en el propio evento para mostrarla en el detalle por dia (como Jibble).
    const setDuracion = (eventoRef, fromTime, toTime) => {
      let effectiveEnd = new Date(toTime).getTime();
      if (chileLocalDate(fromTime) !== chileLocalDate(effectiveEnd)) {
        effectiveEnd = findDayBoundary(fromTime, toTime);
      }
      const hrs = (effectiveEnd - new Date(fromTime).getTime()) / 3600000;
      eventoRef.duracionHoras = hrs > 0 ? Math.round(hrs * 100) / 100 : 0;
    };

    for (const e of list) {
      const dia = e.belongsToDate || e.time.slice(0, 10);
      if (!eventosPorDia.has(dia)) eventosPorDia.set(dia, []);
      const eventoRef = { tipo: e.type, hora: e.time, duracionHoras: null };
      eventosPorDia.get(dia).push(eventoRef);

      if (e.type === "In") {
        if (pendingIn) {
          // Doble "In" sin cierre intermedio: no se descarta el tramo
          // anterior, se cierra en este mismo instante.
          addTramo(pendingIn, e.time);
          setDuracion(pendingIn.eventoRef, pendingIn.time, e.time);
        }
        if (pendingBreak) {
          // El descanso termina al retomar el trabajo.
          setDuracion(pendingBreak.eventoRef, pendingBreak.time, e.time);
          pendingBreak = null;
        }
        pendingIn = { time: e.time, belongsToDate: e.belongsToDate, eventoRef };
      } else if (e.type === "Out" && pendingIn) {
        addTramo(pendingIn, e.time);
        setDuracion(pendingIn.eventoRef, pendingIn.time, e.time);
        pendingIn = null;
      } else if (e.type === "StartBreak" && pendingIn) {
        addTramo(pendingIn, e.time);
        setDuracion(pendingIn.eventoRef, pendingIn.time, e.time);
        pendingIn = null;
        pendingBreak = { time: e.time, belongsToDate: e.belongsToDate, eventoRef };
      }
      // Otros tipos (p.ej. EndBreak) no abren ni cierran tramo.
    }

    if (pendingIn && rangeEnd > new Date(pendingIn.time).getTime()) {
      addTramo(pendingIn, rangeEnd);
      setDuracion(pendingIn.eventoRef, pendingIn.time, rangeEnd);
    }
    if (pendingBreak && rangeEnd > new Date(pendingBreak.time).getTime()) {
      setDuracion(pendingBreak.eventoRef, pendingBreak.time, rangeEnd);
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

function getCuentaConfigOrThrow(env, cuentaId) {
  const cuenta = getCuentaConfig(env, cuentaId);
  if (!cuenta.clientId || !cuenta.clientSecret) {
    const err = new Error(
      `La cuenta "${cuentaId}" no tiene credenciales configuradas (faltan JIBBLE_CLIENT_ID${
        cuentaId === "1" ? "" : "_" + cuentaId
      } / JIBBLE_CLIENT_SECRET${cuentaId === "1" ? "" : "_" + cuentaId} como Secret).`
    );
    err.status = 400;
    throw err;
  }
  return cuenta;
}

async function handleHorasSemana(url, env) {
  const params = url.searchParams;
  const cuenta = getCuentaConfigOrThrow(env, params.get("cuenta") || "1");
  const { from: defaultFrom, to: defaultTo } = currentWeekRangeChile();
  const from = params.get("from") || defaultFrom;
  const to = params.get("to") || defaultTo;

  const token = await getJibbleToken(cuenta);
  const [peopleMap, entries] = await Promise.all([
    getPeopleMap(token),
    fetchTimeEntries(token, from, to),
  ]);

  const totals = computeWorkedHours(entries, `${to}T23:59:59Z`);

  const allowedNames = cuenta.employeeNames
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

  return { cuenta: cuenta.id, nombreCuenta: cuenta.nombre, from, to, empleados: result };
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
        const cuenta = getCuentaConfigOrThrow(env, params.get("cuenta") || "1");
        const { from: defaultFrom, to: defaultTo } = currentWeekRangeChile();
        const from = params.get("from") || defaultFrom;
        const to = params.get("to") || defaultTo;
        const token = await getJibbleToken(cuenta);
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
        return json({ cuenta: cuenta.id, from, to, empleados, cantidadDeMarcajes: entries.length, marcajesCrudos: entries.slice(0, 20) });
      }

      if (url.pathname === "/cuentas" && request.method === "GET") {
        const cuentas = listCuentasConfiguradas(env).map((c) => ({ id: c.id, nombre: c.nombre }));
        return json({ cuentas });
      }

      return json({ error: "Ruta no encontrada. Usa GET /horas-semana, GET /debug o GET /cuentas." }, 404);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || "Error interno" }, status);
    }
  },
};
