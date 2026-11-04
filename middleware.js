// Toegangscode voor de hele Fudura-site (Vercel Routing Middleware, draait op de server).
// De code zelf staat hier niet in, alleen de SHA-256-hash ervan.
const CODE_HASH = 'ce8457d59078a699acb70416f88155a96a906b7b7aad43708402e3a3bcc8a4b4';
const COOKIE = 'fudura_toegang';

async function sha256(tekst) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tekst));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const doorgaan = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

function loginPagina(fout) {
  return new Response(`<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fudura – toegang</title>
<style>
  :root{--bg:#f4f6f7;--card:#fff;--tekst:#1d2830;--rand:#c3ccd2;--accent:#1b4f8a;--fout:#b3261e}
  @media (prefers-color-scheme: dark){:root{--bg:#141a1f;--card:#1e262d;--tekst:#e6ebee;--rand:#38444d;--accent:#7fb0e6;--fout:#f2867f}}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tekst);font:15px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box}
  form{background:var(--card);border:1px solid var(--rand);border-radius:12px;padding:28px 26px;width:100%;max-width:340px;box-shadow:0 6px 24px rgba(0,0,0,.08)}
  h1{font-size:19px;margin:0 0 4px} p{margin:0 0 18px;opacity:.75;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:16px;border:1px solid var(--rand);border-radius:8px;background:transparent;color:inherit}
  button{margin-top:12px;width:100%;padding:11px;font-size:15px;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
  .fout{color:var(--fout);font-size:13px;margin-top:10px}
</style></head><body>
<form method="POST"><h1>Fudura</h1><p>Deze omgeving is afgeschermd. Voer de toegangscode in.</p>
<input type="password" name="code" autocomplete="current-password" placeholder="Toegangscode" autofocus required>
<button type="submit">Openen</button>${fout ? '<div class="fout">Onjuiste code, probeer het opnieuw.</div>' : ''}</form>
</body></html>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default async function middleware(request) {
  const sessie = await sha256('fudura-sessie:' + CODE_HASH);
  const cookies = request.headers.get('cookie') || '';
  if (cookies.split(/;\s*/).includes(`${COOKIE}=${sessie}`)) return doorgaan();

  if (request.method === 'POST') {
    let code = '';
    try { code = String((await request.formData()).get('code') || '').trim(); } catch (e) {}
    if (code && await sha256(code) === CODE_HASH) {
      return new Response(null, { status: 303, headers: {
        location: new URL(request.url).pathname,
        'set-cookie': `${COOKIE}=${sessie}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store' } });
    }
    return loginPagina(true);
  }
  return loginPagina(false);
}

export const config = { matcher: '/:path*' };
