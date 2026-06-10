interface Env {
  DB: D1Database;
  STATS_SECRET: string;
}

const CORS_ORIGINS: ReadonlySet<string> = new Set([
  "https://dr-fit.co",
  "https://www.dr-fit.co",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const MAX_BODY_SIZE = 1024;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowOrigin = CORS_ORIGINS.has(origin) ? origin : "";
  
  // Dynamically reflect requested headers back if provided, otherwise default to Content-Type
  const reqHeaders = req.headers.get("Access-Control-Request-Headers") ?? "Content-Type";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Max-Age": "86400", // cache preflight for 24 hours
  };
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "POST" && url.pathname === "/api/view") {
      const cl = parseInt(request.headers.get("Content-Length") ?? "0", 10);
      if (cl > MAX_BODY_SIZE) return json({ error: "Payload too large" }, 413, cors);

      try {
        const body = await request.json<{
          video_id: string;
          percent_watched: number;
          duration?: number;
        }>();

        const videoId = typeof body.video_id === "string" ? body.video_id.trim().slice(0, 100) : "";
        if (!videoId || typeof body.percent_watched !== "number") {
          return json({ error: "video_id and percent_watched required" }, 400, cors);
        }

        const pct = Math.min(100, Math.max(0, Math.round(body.percent_watched)));
        const dur = Math.max(0, Math.round(body.duration ?? 0));
        
        // CF-IPCountry is guaranteed by Cloudflare on incoming requests, but could be absent locally
        let country = request.headers.get("CF-IPCountry") ?? "XX";
        if (country.length > 3) country = "XX";

        await env.DB.prepare(
          "INSERT INTO views (video_id, percent_watched, duration, country) VALUES (?, ?, ?, ?)"
        ).bind(videoId, pct, dur, country).run();

        return json({ ok: true }, 200, cors);
      } catch (e) {
        console.error("[vsl-analytics] POST /api/view error:", e);
        return json({ error: "Invalid request" }, 400, cors);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.STATS_SECRET) {
        return json({ error: "Unauthorized" }, 401, {});
      }

      const rawDays = parseInt(url.searchParams.get("days") ?? "30", 10);
      const days = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? rawDays : 30));
      const videoId = url.searchParams.get("video_id");

      const where = videoId
        ? "WHERE video_id = ? AND created_at >= datetime('now', ?)"
        : "WHERE created_at >= datetime('now', ?)";
      const params = videoId ? [videoId, `-${days} days`] : [`-${days} days`];

      try {
        const overall = await env.DB.prepare(
          `SELECT video_id, COUNT(*) as total_views, ROUND(AVG(percent_watched),1) as avg_percent_watched, ROUND(AVG(duration),0) as avg_duration, MIN(percent_watched) as min_percent, MAX(percent_watched) as max_percent FROM views ${where} GROUP BY video_id ORDER BY total_views DESC`
        ).bind(...params).all();

        const daily = await env.DB.prepare(
          `SELECT video_id, DATE(created_at) as date, COUNT(*) as views, ROUND(AVG(percent_watched),1) as avg_percent FROM views ${where} GROUP BY video_id, DATE(created_at) ORDER BY date DESC LIMIT 90`
        ).bind(...params).all();

        const countries = await env.DB.prepare(
          `SELECT video_id, country, COUNT(*) as views, ROUND(AVG(percent_watched),1) as avg_percent FROM views ${where} AND country != '' GROUP BY video_id, country ORDER BY views DESC LIMIT 20`
        ).bind(...params).all();

        return new Response(
          JSON.stringify({ period_days: days, videos: overall.results, daily: daily.results, countries: countries.results }, null, 2),
          { headers: { "Content-Type": "application/json", ...cors } }
        );
      } catch (e) {
        console.error("[vsl-analytics] GET /api/stats error:", e);
        return json({ error: "Internal error" }, 500, cors);
      }
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};
