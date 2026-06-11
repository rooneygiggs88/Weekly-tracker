const STRAVA_API = 'https://www.strava.com';

const ALLOWED_ORIGINS = [
  'https://rooneygiggs88.github.io',
  'http://localhost:8765',
  'http://localhost:8766',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // Exchange auth code for tokens
      if (url.pathname === '/exchange') {
        const code = url.searchParams.get('code');
        if (!code) return err('missing code', 400, cors);
        const res = await fetch(`${STRAVA_API}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
          }),
        });
        return json(await res.json(), res.status, cors);
      }

      // Refresh an expired access token
      if (url.pathname === '/refresh' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.refresh_token) return err('missing refresh_token', 400, cors);
        const res = await fetch(`${STRAVA_API}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            refresh_token: body.refresh_token,
            grant_type: 'refresh_token',
          }),
        });
        return json(await res.json(), res.status, cors);
      }

      // Proxy activities list — keeps access_token out of URLs
      if (url.pathname === '/activities') {
        const auth = request.headers.get('Authorization');
        if (!auth) return err('unauthorized', 401, cors);
        const params = new URLSearchParams();
        for (const [k, v] of url.searchParams) params.set(k, v);
        const res = await fetch(
          `${STRAVA_API}/api/v3/athlete/activities?${params}`,
          { headers: { Authorization: auth } }
        );
        return json(await res.json(), res.status, cors);
      }

      return err('not found', 404, cors);
    } catch (e) {
      return err('internal error', 500, cors);
    }
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function err(msg, status, headers) {
  return json({ error: msg }, status, headers);
}
