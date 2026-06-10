interface Env {
  DB: D1Database;
  STATS_SECRET: string; // Set via: wrangler secret put STATS_SECRET
}

const CORS_ORIGINS = [
  "https://dr-fit.co",
  "https://www.dr-fit.co",
  "http://localhost:3000",
  "http://localhost:3001",
];

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = CORS_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /api/view — record a view
    if (request.method === "POST" && url.pathname === "/api/view") {
      try {
        const body = await request.json<{
          video_id: string;
          percent_watched: number;
          duration?: number;
        }>();

        if (!body.video_id || typeof body.percent_watched !== "number") {
          return new Response(
            JSON.stringify({ error: "video_id and percent_watched required" }),
            { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }

        const country = request.headers.get("CF-IPCountry") || "";

        await env.DB.prepare(
          "INSERT INTO views (video_id, percent_watched, duration, country) VALUES (?, ?, ?, ?)"
        )
          .bind(
            body.video_id,
            Math.min(100, Math.max(0, Math.round(body.percent_watched))),
            body.duration || 0,
            country
          )
          .run();

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Invalid request" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // GET /api/stats — query stats (protected)
    if (request.method === "GET" && url.pathname === "/api/stats") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.STATS_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const videoId = url.searchParams.get("video_id");
      const days = parseInt(url.searchParams.get("days") || "30");

      // Overall stats
      const whereClause = videoId
        ? "WHERE video_id = ? AND created_at >= datetime('now', ?)"
        : "WHERE created_at >= datetime('now', ?)";

      const bindParams = videoId
        ? [videoId, `-${days} days`]
        : [`-${days} days`];

      const overall = await env.DB.prepare(
        `SELECT
          video_id,
          COUNT(*) as total_views,
          ROUND(AVG(percent_watched), 1) as avg_percent_watched,
          ROUND(AVG(duration), 0) as avg_duration,
          MIN(percent_watched) as min_percent,
          MAX(percent_watched) as max_percent
        FROM views
        ${whereClause}
        GROUP BY video_id
        ORDER BY total_views DESC`
      )
        .bind(...bindParams)
        .all();

      // Daily breakdown
      const daily = await env.DB.prepare(
        `SELECT
          video_id,
          DATE(created_at) as date,
          COUNT(*) as views,
          ROUND(AVG(percent_watched), 1) as avg_percent
        FROM views
        ${whereClause}
        GROUP BY video_id, DATE(created_at)
        ORDER BY date DESC
        LIMIT 90`
      )
        .bind(...bindParams)
        .all();

      // Country breakdown
      const countries = await env.DB.prepare(
        `SELECT
          video_id,
          country,
          COUNT(*) as views,
          ROUND(AVG(percent_watched), 1) as avg_percent
        FROM views
        ${whereClause} AND country != ''
        GROUP BY video_id, country
        ORDER BY views DESC
        LIMIT 20`
      )
        .bind(...bindParams)
        .all();

      return new Response(
        JSON.stringify(
          {
            period_days: days,
            videos: overall.results,
            daily: daily.results,
            countries: countries.results,
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
