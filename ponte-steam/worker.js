// One Bit — ponte da Steam (Cloudflare Worker)
//
// Esta ponte busca na Steam os seus jogos e conquistas e entrega para o One Bit.
// A chave da Steam NÃO fica neste arquivo: ela é guardada na Cloudflare como
// segredo, com o nome STEAM_KEY (Settings → Variables and Secrets).
//
// Rotas:
//   GET /games?perfil=<SteamID64, link do perfil ou nome personalizado>
//       → { steamid, games: [{ appid, name, hours }] }
//   GET /ach?steamid=<SteamID64>&appid=<id do jogo>
//       → { achievements: [{ api, name, nameEn, desc, achieved, unlocktime }] }
//   GET /capa?appids=<id>,<id>,…   (até 50 por vez)
//       → { capas: { "<appid>": "<link da capa vertical na Steam>" } }

const ORIGENS = [
  'https://onebitcollection.github.io',
];

const API = 'https://api.steampowered.com';

function cors(origin) {
  const ok = ORIGENS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ORIGENS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(origin)),
  });
}

async function steam(path, params, key) {
  const u = new URL(API + path);
  u.searchParams.set('key', key);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), { headers: { 'User-Agent': 'OneBit-ponte' } });
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, body };
}

async function resolverPerfil(raw, key) {
  raw = String(raw || '').trim();
  let m = raw.match(/(\d{17})/);
  if (m) return m[1];
  m = raw.match(/steamcommunity\.com\/id\/([^\/?#\s]+)/i) || raw.match(/^([A-Za-z0-9_-]{2,40})$/);
  if (!m) return null;
  const r = await steam('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: m[1] }, key);
  const res = r.body && r.body.response;
  return res && res.success === 1 ? res.steamid : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'GET') return json({ erro: 'metodo' }, 405, origin);

    const key = env.STEAM_KEY;
    if (!key) return json({ erro: 'sem_chave', msg: 'A chave da Steam não foi configurada na ponte (STEAM_KEY).' }, 500, origin);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/ping') {
        return json({ ok: true, app: 'One Bit — ponte da Steam' }, 200, origin);
      }

      if (url.pathname === '/games') {
        const steamid = await resolverPerfil(url.searchParams.get('perfil'), key);
        if (!steamid) return json({ erro: 'perfil', msg: 'Não encontrei esse perfil da Steam.' }, 404, origin);
        const r = await steam('/IPlayerService/GetOwnedGames/v1/', {
          steamid, include_appinfo: '1', include_played_free_games: '1',
        }, key);
        if (r.status === 401 || r.status === 403) return json({ erro: 'chave', msg: 'A Steam recusou a chave. Confira a STEAM_KEY.' }, 502, origin);
        const res = (r.body && r.body.response) || {};
        if (!res.games) return json({ erro: 'privado', steamid, msg: 'A lista de jogos está privada. Deixe "Detalhes de jogo" como Público na privacidade da Steam.' }, 403, origin);
        const games = res.games.map(g => ({
          appid: String(g.appid),
          name: g.name || '',
          hours: Math.round((g.playtime_forever || 0) / 6) / 10,
        }));
        return json({ steamid, games }, 200, origin);
      }

      if (url.pathname === '/ach') {
        const steamid = url.searchParams.get('steamid') || '';
        const appid = url.searchParams.get('appid') || '';
        if (!/^\d{17}$/.test(steamid) || !/^\d+$/.test(appid)) return json({ erro: 'parametros' }, 400, origin);
        const [br, en] = await Promise.all([
          steam('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid, appid, l: 'brazilian' }, key),
          steam('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid, appid, l: 'english' }, key),
        ]);
        const ps = br.body && br.body.playerstats;
        if (!ps || ps.success === false) {
          const err = (ps && ps.error) || '';
          if (/no stats/i.test(err)) return json({ achievements: [], semConquistas: true }, 200, origin);
          if (/not public|private/i.test(err)) return json({ erro: 'privado', msg: 'As conquistas estão privadas no perfil da Steam.' }, 403, origin);
          return json({ achievements: [], aviso: err || 'sem dados' }, 200, origin);
        }
        const enMap = {};
        ((en.body && en.body.playerstats && en.body.playerstats.achievements) || []).forEach(a => { enMap[a.apiname] = a.name || ''; });
        const achievements = (ps.achievements || []).map(a => ({
          api: a.apiname,
          name: a.name || '',
          nameEn: enMap[a.apiname] || '',
          desc: a.description || '',
          achieved: a.achieved === 1,
          unlocktime: a.unlocktime || 0,
        }));
        return json({ achievements }, 200, origin);
      }

      if (url.pathname === '/capa') {
        const ids = (url.searchParams.get('appids') || '').split(',').filter(x => /^\d+$/.test(x)).slice(0, 50);
        if (!ids.length) return json({ erro: 'parametros' }, 400, origin);
        const input = {
          ids: ids.map(a => ({ appid: Number(a) })),
          context: { language: 'brazilian', country_code: 'BR' },
          data_request: { include_assets: true },
        };
        const r = await steam('/IStoreBrowseService/GetItems/v1/', { input_json: JSON.stringify(input) }, key);
        const items = (r.body && r.body.response && r.body.response.store_items) || [];
        const capas = {};
        items.forEach(it => {
          const a = it.assets || {};
          const file = a.library_capsule || a.library_capsule_2x || a.main_capsule || a.header;
          if (it.appid && a.asset_url_format && file) {
            capas[String(it.appid)] = 'https://shared.steamstatic.com/store_item_assets/' + a.asset_url_format.replace('${FILENAME}', file);
          }
        });
        return json({ capas }, 200, origin);
      }

      return json({ erro: 'rota' }, 404, origin);
    } catch (e) {
      return json({ erro: 'falha', msg: String(e && e.message || e) }, 502, origin);
    }
  },
};
