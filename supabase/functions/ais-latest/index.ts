// supabase/functions/ais-latest/index.ts
// Reads latest AIS positions from public.ais_latest and 6-hour track points from public.ais_positions.
// Returns JSON compatible with HM-AIS-viewer HTML v7.

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

    // Default track window: 6 hours = 360 minutes.
    const minutes = numberParam(url, "minutes", 360);
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY." }, 500);
    }

    // 1) Latest vessel positions for map markers.
    const latestUrl = new URL(`${supabaseUrl}/rest/v1/ais_latest`);
    latestUrl.searchParams.set("select", "mmsi,name,callsign,ship_type,lat,lon,sog,cog,heading,received_at,updated_at");
    latestUrl.searchParams.set("lat", `gte.${latMin}`);
    latestUrl.searchParams.append("lat", `lte.${latMax}`);
    latestUrl.searchParams.set("lon", `gte.${lonMin}`);
    latestUrl.searchParams.append("lon", `lte.${lonMax}`);
    latestUrl.searchParams.set("received_at", `gte.${since}`);
    latestUrl.searchParams.set("order", "received_at.desc");
    latestUrl.searchParams.set("limit", "1000");

    const headers = {
      "apikey": anonKey,
      "Authorization": `Bearer ${anonKey}`,
      "Accept": "application/json",
    };

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

    // 2) Track points for the vessels currently shown on the map.
    const tracks: Record<string, number[][]> = {};
    const mmsis = vessels.map((v: any) => Number(v.mmsi)).filter((m: number) => Number.isFinite(m));

    if (mmsis.length > 0) {
      const trackUrl = new URL(`${supabaseUrl}/rest/v1/ais_positions`);
      trackUrl.searchParams.set("select", "mmsi,lat,lon,received_at");
      trackUrl.searchParams.set("mmsi", `in.(${mmsis.join(",")})`);
      trackUrl.searchParams.set("received_at", `gte.${since}`);
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
        if (Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))) {
          tracks[key].push([Number(row.lat), Number(row.lon)]);
        }
      }

      // Fallback: if a vessel has no history rows yet, use latest position as a single point.
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
      trackWindowMinutes: minutes,
      bounds: { latMin, latMax, lonMin, lonMax },
      vessels,
      tracks,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
