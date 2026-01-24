export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight (harmless; some clients may send it)
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders_(),
      });
    }

    // Map public paths -> GAS "route"
    // Public API:
    //   GET  /health
    //   GET  /tasks/list
    //   GET  /tasks/get
    //   POST /tasks/create
    //   POST /tasks/update
    //   POST /tasks/complete
    //   POST /tasks/snooze
    //   POST /tasks/next
    const path = u.pathname.replace(/\/+$/, "") || "/";

    const route = mapPathToRoute_(path, method);
    if (!route) {
      return json_({ ok: false, error: { code: "NOT_FOUND", message: `No route for ${method} ${path}` } }, 404);
    }

    // Build target URL
    const target = new URL(env.GAS_URL);

    // Forward query params (except route)
    // For GET, we pass route via querystring to GAS: ?route=tasks/list&...
    if (method === "GET") {
      target.searchParams.set("route", route);
      for (const [k, v] of u.searchParams.entries()) {
        if (k === "route" || k === "r") continue;
        target.searchParams.append(k, v);
      }
    }

    // Forward body
    let body = undefined;
    let contentType = request.headers.get("content-type") || "application/json";

    if (method !== "GET") {
      // Read incoming body; if JSON, inject route into body.
      const raw = await request.arrayBuffer();

      if (contentType.includes("application/json")) {
        let obj = {};
        try {
          const txt = new TextDecoder().decode(raw);
          obj = txt ? JSON.parse(txt) : {};
        } catch {
          // leave as {}
        }
        obj.route = obj.route || route; // ensure route present
        body = JSON.stringify(obj);
      } else {
        // Non-JSON body: just pass through (rare for this project)
        body = raw;
      }
    }

    // Fetch GAS. Subrequests default to following redirects; set explicitly anyway. :contentReference[oaicite:2]{index=2}
    const resp = await fetch(target.toString(), {
      method,
      headers: {
        "content-type": contentType,
      },
      body,
      redirect: "follow",
    });

    const text = await resp.text();

    // Return minimal headers so ChatGPT Actions doesn't choke on Google’s envelope
    return new Response(text, {
      status: resp.status,
      headers: {
        ...corsHeaders_(),
        "content-type": resp.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  },
};

function mapPathToRoute_(path, method) {
  if (method === "GET" && (path === "/" || path === "")) return "health";
  if (method === "GET" && path === "/health") return "health";

  if (method === "GET" && path === "/tasks/list") return "tasks/list";
  if (method === "GET" && path === "/tasks/get") return "tasks/get";

  if (method === "POST" && path === "/tasks/create") return "tasks/create";
  if (method === "POST" && path === "/tasks/update") return "tasks/update";
  if (method === "POST" && path === "/tasks/complete") return "tasks/complete";
  if (method === "POST" && path === "/tasks/snooze") return "tasks/snooze";
  if (method === "POST" && path === "/tasks/next") return "tasks/next";

  return null;
}

function corsHeaders_() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json_(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders_(), "content-type": "application/json", "cache-control": "no-store" },
  });
}
