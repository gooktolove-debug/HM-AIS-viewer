// supabase/functions/ais-latest/index.ts
// v18: Current map markers are calculated from ais_positions, not ais_latest.
// This fixes the case where ais_positions is updating but ais_latest is stale.
// - Map markers: latest ais_positions point per MMSI within latestMinutes.
// - Tracks: ais_positions points within trackMinutes for displayed vessels.
// - Static info: optional enrichment from ais_latest (name, callsign, dimensions).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function numberParam(url: URL, name: string, fallback: number): number {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) ? value : fallback;
}

function ageMinutes(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 999999;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);

    const latMin = numberParam(url, "latMin", -36.92);
    const latMax = numberParam(url, "latMax", -36.75);
    const lonMin = numberParam(url, "lonMin", 174.66);
    const lonMax = numberParam(url, "lonMax", 174.95);

    // Current marker window and track window are deliberately separate.
    const latestMinutes = numberParam(url, "latestMinutes", 60);
    const trackMinutes = numberParam(url, "trackMinutes", numberParam(url, "minutes", 360));

    const latestSince = new Date(Date.now() - latestMinutes * 60 * 1000).toISOString();
    const trackSince = new Date(Date.now() - trackMinutes * 60 * 1000).toISOString();

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY." }, 500);
    }

    const headers = {
      "apikey": anonKey,
      "Authorization": `Bearer ${anonKey}`,
      "Accept": "application/json",
    };

    // 1) Read recent position history from ais_positions.
    // This table is confirmed to be updating, so it becomes the source of truth for current map markers.
    const posUrl = new URL(`${supabaseUrl}/rest/v1/ais_positions`);
    posUrl.searchParams.set("select", "mmsi,lat,lon,sog,cog,heading,received_at");
    posUrl.searchParams.set("lat", `gte.${latMin}`);
    posUrl.searchParams.append("lat", `lte.${latMax}`);
    posUrl.searchParams.set("lon", `gte.${lonMin}`);
    posUrl.searchParams.append("lon", `lte.${lonMax}`);
    posUrl.searchParams.set("received_at", `gte.${trackSince}`);
    posUrl.searchParams.set("order", "mmsi.asc,received_at.asc");
    posUrl.searchParams.set("limit", "20000");

    const posRes = await fetch(posUrl.toString(), { method: "GET", headers });
    if (!posRes.ok) {
      return jsonResponse({
        ok: false,
        error: "Failed to read ais_positions.",
        status: posRes.status,
        details: await posRes.text(),
        query: posUrl.toString(),
      }, 500);
    }

    const posRows = await posRes.json();

    const tracks: Record<string, number[][]> = {};
    const latestByMmsi = new Map<number, any>();

    for (const row of posRows) {
      const mmsi = Number(row.mmsi);
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(mmsi) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

      const key = String(mmsi);
      if (!tracks[key]) tracks[key] = [];
      tracks[key].push([lat, lon]);

      // Rows are ordered by mmsi asc, received_at asc, so later rows overwrite older rows.
      latestByMmsi.set(mmsi, row);
    }

    // Only display current/recent vessels on the map.
    const latestRows = Array.from(latestByMmsi.values()).filter((row: any) => {
      return new Date(row.received_at).getTime() >= new Date(latestSince).getTime();
    });

    const mmsis = latestRows.map((row: any) => Number(row.mmsi)).filter((m: number) => Number.isFinite(m));

    // 2) Optional static enrichment from ais_latest.
    const staticByMmsi = new Map<number, any>();
    if (mmsis.length > 0) {
      const staticUrl = new URL(`${supabaseUrl}/rest/v1/ais_latest`);
      staticUrl.searchParams.set("select", "mmsi,name,callsign,ship_type,loa,breadth,draft,updated_at");
      staticUrl.searchParams.set("mmsi", `in.(${mmsis.join(",")})`);
      staticUrl.searchParams.set("limit", "1000");

      const staticRes = await fetch(staticUrl.toString(), { method: "GET", headers });
      if (staticRes.ok) {
        const staticRows = await staticRes.json();
        for (const row of staticRows) {
          staticByMmsi.set(Number(row.mmsi), row);
        }
      }
    }

    const vessels = latestRows.map((row: any) => {
      const mmsi = Number(row.mmsi);
      const s = staticByMmsi.get(mmsi) || {};
      return {
        mmsi,
        imo: 0,
        name: s.name && String(s.name).trim() ? String(s.name).trim() : `MMSI ${mmsi}`,
        callsign: s.callsign || "",
        type: "Other",
        loa: s.loa,
        breadth: s.breadth,
        draft: s.draft,
        lat: Number(row.lat),
        lon: Number(row.lon),
        sog: row.sog,
        cog: row.cog,
        heading: row.heading,
        navStatus: "",
        destination: "",
        eta: "",
        received_at: row.received_at,
        lastSeenMin: ageMinutes(row.received_at),
        source: "AISStream / ais_positions",
      };
    });

    // Remove tracks for vessels that are not displayed.
    const displayed = new Set(vessels.map((v: any) => String(v.mmsi)));
    for (const key of Object.keys(tracks)) {
      if (!displayed.has(key)) delete tracks[key];
    }

    // Fallback one-point tracks for displayed vessels without any track rows.
    for (const vessel of vessels) {
      const key = String(vessel.mmsi);
      if (!tracks[key] || tracks[key].length === 0) {
        tracks[key] = [[Number(vessel.lat), Number(vessel.lon)]];
      }
    }

    return jsonResponse({
      ok: true,
      provider: "AISStream via Supabase",
      sourceTable: "ais_positions",
      count: vessels.length,
      latestWindowMinutes: latestMinutes,
      trackWindowMinutes: trackMinutes,
      latestSince,
      trackSince,
      bounds: { latMin, latMax, lonMin, lonMax },
      vessels,
      tracks,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
