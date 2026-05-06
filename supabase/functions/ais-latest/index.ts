
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const now = new Date().toISOString();

  return jsonResponse({
    ok: true,
    provider: "demo",
    vessels: [
      {
        mmsi: 512345001,
        imo: 9412345,
        name: "DEMO ATLAS TRADER",
        callsign: "ZMAT1",
        type: 70,
        lat: -36.8357,
        lon: 174.7921,
        sog: 8.4,
        cog: 262,
        heading: 260,
        navStatus: 0,
        destination: "AUCKLAND",
        eta: "",
        received_at: now,
        source: "demo",
      },
      {
        mmsi: 512345002,
        imo: 9323456,
        name: "DEMO HAURAKI STAR",
        callsign: "ZMHS2",
        type: 80,
        lat: -36.8068,
        lon: 174.8466,
        sog: 0.1,
        cog: 89,
        heading: 91,
        navStatus: 1,
        destination: "ANCHORAGE",
        eta: "",
        received_at: now,
        source: "demo",
      },
      {
        mmsi: 512345003,
        imo: 0,
        name: "DEMO WAITEMATA PILOT",
        callsign: "ZMWP3",
        type: 52,
        lat: -36.8424,
        lon: 174.7819,
        sog: 12.1,
        cog: 33,
        heading: 35,
        navStatus: 0,
        destination: "PILOT STATION",
        eta: "",
        received_at: now,
        source: "demo",
      },
    ],
  });
});
