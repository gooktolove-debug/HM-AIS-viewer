
// supabase/functions/ais-latest/index.ts
// Reads latest AIS positions from Supabase table: public.ais_latest
// Returns JSON format compatible with HM-AIS-viewer HTML v3.

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(req.url);

    // HTML viewer passes these automatically.
    const latMin = numberParam(url, "latMin", -36.92);
    const latMax = numberParam(url, "latMax", -36.75);
    const lonMin = numberParam(url, "lonMin", 174.66);
    const lonMax = numberParam(url, "lonMax", 174.95);

    // Show only recent data. Default: last 60 minutes.
    const minutes = numberParam(url, "minutes", 60);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !anonKey) {
      return jsonResponse({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY in Edge Function environment.",
      }, 500);
    }

    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const restUrl = new URL(`${supabaseUrl}/rest/v1/ais_latest`);
    restUrl.searchParams.set("select", "mmsi,lat,lon,sog,cog,heading,received_at");
    restUrl.searchParams.set("lat", `gte.${latMin}`);
    restUrl.searchParams.append("lat", `lte.${latMax}`);
    restUrl.searchParams.set("lon", `gte.${lonMin}`);
    restUrl.searchParams.append("lon", `lte.${lonMax}`);
    restUrl.searchParams.set("received_at", `gte.${since}`);
    restUrl.searchParams.set("order", "received_at.desc");
    restUrl.searchParams.set("limit", "1000");

    const res = await fetch(restUrl.toString(), {
      method: "GET",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      return jsonResponse({
        ok: false,
        error: "Failed to read ais_latest from Supabase REST.",
        status: res.status,
        details: errorText,
      }, 500);
    }

    const rows = await res.json();

    const vessels = rows.map((row: any) => ({
      mmsi: row.mmsi,
      imo: 0,
      name: `MMSI ${row.mmsi}`,
      callsign: "",
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

    return jsonResponse({
      ok: true,
      provider: "AISStream via Supabase",
      count: vessels.length,
      bounds: { latMin, latMax, lonMin, lonMax },
      vessels,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
