// supabase/functions/ais-latest/index.ts
// Current-only map markers + recent 6h tracks for displayed vessels.
// Map markers: only vessels with a recent ais_latest.received_at within latestMinutes.
// Tracks: only for displayed vessels, from ais_positions within trackMinutes.

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);

    const latMin = numberParam(url, "latMin", -36.92);
    const latMax = numberParam(url, "latMax", -36.75);
    const lonMin = numberParam(url, "lonMin", 174.66);
    const lonMax = numberParam(url, "lonMax", 174.95);

    // Important separation:
    // latestMinutes controls what appears on the MAP now.
    // trackMinutes controls how far back the track line can go for those displayed vessels.
    const latestMinutes = numberParam(url, "latestMinutes", 10);
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

    // 1) Latest/current vessels only.
    const latestUrl = new URL(`${supabaseUrl}/rest/v1/ais_latest`);
    latestUrl.searchParams.set("select", "mmsi,name,callsign,ship_type,loa,breadth,draft,lat,lon,sog,cog,heading,received_at,updated_at");
    latestUrl.searchParams.set("lat", `gte.${latMin}`);
    latestUrl.searchParams.append("lat", `lte.${latMax}`);
    latestUrl.searchParams.set("lon", `gte.${lonMin}`);
    latestUrl.searchParams.append("lon", `lte.${lonMax}`);
    latestUrl.searchParams.set("received_at", `gte.${latestSince}`);
    latestUrl.searchParams.set("order", "received_at.desc");
    latestUrl.searchParams.set("limit", "1000");

    const latestRes = await fetch(latestUrl.toString(), { method: "GET", headers });

    if (!latestRes.ok) {
      return jsonResponse({
        ok: false,
        error: "Failed to read ais_latest.",
        status: latestRes.status,
        details: await latestRes.text(),
      }, 500);
    }

    const latestRows = await latestRes.json();

    const vessels = latestRows.map((row: any) => ({
      mmsi: row.mmsi,
      imo: 0,
      name: row.name && String(row.name).trim() ? String(row.name).trim() : `MMSI ${row.mmsi}`,
      callsign: row.callsign || "",
      type: "Other",
      loa: row.loa,
      breadth: row.breadth,
      draft: row.draft,
      lat: row.lat,
      lon: row.lon,
      sog: row.sog,
      cog: row.cog,
      heading: row.heading,
      navStatus: "",
      destination: "",
      eta: "",
      received_at: row.received_at,
      source: "AISStream",
    }));

    // 2) Tracks only for vessels currently displayed.
    const tracks: Record<string, number[][]> = {};
    const mmsis = vessels.map((v: any) => Number(v.mmsi)).filter((m: number) => Number.isFinite(m));

    if (mmsis.length > 0) {
      const trackUrl = new URL(`${supabaseUrl}/rest/v1/ais_positions`);
      trackUrl.searchParams.set("select", "mmsi,lat,lon,received_at");
      trackUrl.searchParams.set("mmsi", `in.(${mmsis.join(",")})`);
      trackUrl.searchParams.set("received_at", `gte.${trackSince}`);
      trackUrl.searchParams.set("order", "mmsi.asc,received_at.asc");
      trackUrl.searchParams.set("limit", "10000");

      const trackRes = await fetch(trackUrl.toString(), { method: "GET", headers });

      if (!trackRes.ok) {
        return jsonResponse({
          ok: false,
          error: "Failed to read ais_positions.",
          status: trackRes.status,
          details: await trackRes.text(),
        }, 500);
      }

      const trackRows = await trackRes.json();

      for (const row of trackRows) {
        const key = String(row.mmsi);
        if (!tracks[key]) tracks[key] = [];
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          tracks[key].push([lat, lon]);
        }
      }

      // Fallback: if a displayed vessel has no history yet, use its latest point.
      for (const vessel of vessels) {
        const key = String(vessel.mmsi);
        if (!tracks[key] || tracks[key].length === 0) {
          tracks[key] = [[Number(vessel.lat), Number(vessel.lon)]];
        }
      }
    }

    return jsonResponse({
      ok: true,
      provider: "AISStream via Supabase",
      count: vessels.length,
      latestWindowMinutes: latestMinutes,
      trackWindowMinutes: trackMinutes,
      bounds: { latMin, latMax, lonMin, lonMax },
      vessels,
      tracks,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
