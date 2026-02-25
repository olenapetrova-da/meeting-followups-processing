/**
 * Cloudflare Worker — Google Drive push → KV gate → n8n webhook
 *
 * Endpoints:
 *  - POST /drive/push  : where Google Drive push pings will be sent
 *  - POST /drive/setup : a manual endpoint you call once to create/renew the watch
 *
 * KV:
 *  - one key (env.STATE_KEY) holding JSON state
 *
 * Required bindings / vars:
 *  - KV (KV namespace binding)
 *  - env.STATE_KEY (Text) = "drive_watch_state"
 *  - env.INTAKE_FOLDER_ID (Text)
 *  - env.N8N_WEBHOOK_URL (Text)
 *  - env.GOOGLE_CLIENT_ID (Secret)
 *  - env.GOOGLE_CLIENT_SECRET (Secret)
 *  - env.GOOGLE_REFRESH_TOKEN (Secret)
 *  - env.N8N_SHARED_SECRET (Secret)
 */

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

const MAX_CHANGE_PAGES = 10;
const PAGE_SIZE = 100;

// "New file" heuristic: change time close to created time ⇒ likely creation/upload, not a move.
const NEW_FILE_MAX_LAG_MS = 5 * 60 * 1000; // 5 min

// Dedupe window for emitted fileIds (Worker-side)
const EMIT_DEDUPE_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const EMIT_DEDUPE_MAX_KEYS = 200;

// Avoid concurrent processing on bursty duplicate pings (best-effort)
const IN_FLIGHT_WINDOW_MS = 30 * 1000;

// Renewal threshold
const RENEW_IF_EXPIRES_WITHIN_MS = 24 * 60 * 60 * 1000; // 24h

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/drive/setup") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const pushUrl = new URL("/drive/push", url.origin).toString();
        const res = await setupOrRenewWatch(env, pushUrl, { forceRenew: true });
        return json(res, 200);
      }

      if (path === "/drive/push") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const res = await handleDrivePush(request, env, ctx);
        return json(res, 200);
      }

      return json({ ok: true, name: "pmi-drive-watch", endpoints: ["/drive/setup", "/drive/push"] }, 200);
    } catch (e) {
      return json({ error: "worker_error", details: String(e?.message ?? e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(renewIfNeeded(env));
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function getState(env) {
  const key = env.STATE_KEY || "drive_watch_state";
  const s = await env.KV.get(key, "json");
  return s || null;
}

async function putState(env, state) {
  const key = env.STATE_KEY || "drive_watch_state";
  await env.KV.put(key, JSON.stringify(state));
}

function nowMs() {
  return Date.now();
}

function pruneRecentEmitted(mapObj) {
  const t = nowMs();
  const entries = Object.entries(mapObj || {});
  // prune old
  const fresh = entries.filter(([, ts]) => Number(ts) && t - Number(ts) <= EMIT_DEDUPE_TTL_MS);
  // cap size
  fresh.sort((a, b) => Number(b[1]) - Number(a[1]));
  const capped = fresh.slice(0, EMIT_DEDUPE_MAX_KEYS);
  return Object.fromEntries(capped);
}

function header(request, name) {
  return request.headers.get(name) || request.headers.get(name.toLowerCase()) || "";
}

function toBigIntOrNull(s) {
  try {
    if (!s) return null;
    return BigInt(s);
  } catch {
    return null;
  }
}

async function getAccessToken(env) {
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("refresh_token", env.GOOGLE_REFRESH_TOKEN);
  body.set("grant_type", "refresh_token");

  const r = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`oauth_refresh_failed:${r.status}:${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error("oauth_refresh_missing_access_token");
  return j.access_token;
}

async function driveFetch(env, accessToken, path, { method = "GET", query = {}, body = null } = {}) {
  const u = new URL(DRIVE_API + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }

  const r = await fetch(u.toString(), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`drive_api_failed:${method}:${path}:${r.status}:${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function setupOrRenewWatch(env, pushUrl, { forceRenew }) {
  const state = (await getState(env)) || {};

  const accessToken = await getAccessToken(env);

  // Best-effort stop old channel (if exists)
  if (forceRenew && state.channelId && state.resourceId) {
    try {
      await driveFetch(env, accessToken, "/channels/stop", {
        method: "POST",
        body: { id: state.channelId, resourceId: state.resourceId },
      });
    } catch {
      // ignore for demo
    }
  }

  // Ensure pageToken
  let pageToken = state.pageToken;
  if (!pageToken) {
    const sp = await driveFetch(env, accessToken, "/changes/startPageToken", {
      query: { restrictToMyDrive: "true", fields: "startPageToken" },
    });
    pageToken = sp.startPageToken;
  }

  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomUUID(); // validated on push via X-Goog-Channel-Token
  const watchRes = await driveFetch(env, accessToken, "/changes/watch", {
    method: "POST",
    query: {
      pageToken,
      restrictToMyDrive: "true",
      // NOTE: address in body below
    },
    body: {
      id: channelId,
      type: "web_hook",
      address: pushUrl,
      token: channelToken,
    },
  });

  const expirationMs = watchRes.expiration ? Number(watchRes.expiration) : null;

  const nextState = {
    ...state,
    folderId: env.INTAKE_FOLDER_ID,
    pushUrl,
    pageToken,
    channelId: watchRes.id || channelId,
    resourceId: watchRes.resourceId,
    channelToken,
    expirationMs,
    lastMessageNumber: state.lastMessageNumber || null,
    lastMaxChangeTimeMs: state.lastMaxChangeTimeMs || null,
    recentEmitted: pruneRecentEmitted(state.recentEmitted || {}),
    inFlightUntilMs: 0,
  };

  await putState(env, nextState);

  return {
    ok: true,
    action: forceRenew ? "renewed" : "setup",
    pushUrl,
    channelId: nextState.channelId,
    resourceId: nextState.resourceId,
    expirationMs: nextState.expirationMs,
  };
}

async function handleDrivePush(request, env, ctx) {
  const state = await getState(env);
  if (!state?.channelId || !state?.resourceId) {
    return { ok: false, error: "not_setup_yet" };
  }

  // Validate channel headers
  const chId = header(request, "X-Goog-Channel-ID");
  const resId = header(request, "X-Goog-Resource-ID");
  const chToken = header(request, "X-Goog-Channel-Token");
  const resState = header(request, "X-Goog-Resource-State");
  const msgNoStr = header(request, "X-Goog-Message-Number");

  if (chId !== state.channelId || resId !== state.resourceId) {
    return { ok: false, error: "channel_mismatch" };
  }
  if (state.channelToken && chToken && chToken !== state.channelToken) {
    return { ok: false, error: "token_mismatch" };
  }

  // Ignore sync message
  if (resState === "sync") {
    return { ok: true, ignored: "sync" };
  }

  // Best-effort de-dupe by message number
  const msgNo = toBigIntOrNull(msgNoStr);
  const lastMsgNo = toBigIntOrNull(state.lastMessageNumber);
  if (msgNo !== null && lastMsgNo !== null && msgNo <= lastMsgNo) {
    return { ok: true, ignored: "duplicate_message_number" };
  }

  // Best-effort in-flight guard (KV isn't atomic; this just reduces duplicates)
  const t = nowMs();
  if (state.inFlightUntilMs && t < Number(state.inFlightUntilMs)) {
    return { ok: true, ignored: "in_flight" };
  }
  state.inFlightUntilMs = t + IN_FLIGHT_WINDOW_MS;
  await putState(env, state);

  const accessToken = await getAccessToken(env);

  const fields =
    "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,trashed,createdTime,webViewLink))";

  let pageToken = state.pageToken;
  let nextPageToken = null;

  let maxChangeTimeMs = Number(state.lastMaxChangeTimeMs || 0);
  const folderId = env.INTAKE_FOLDER_ID;

  const emitted = [];
  let recentEmitted = pruneRecentEmitted(state.recentEmitted || {});

  for (let i = 0; i < MAX_CHANGE_PAGES; i++) {
    const resp = await driveFetch(env, accessToken, "/changes", {
      query: {
        pageToken,
        pageSize: String(PAGE_SIZE),
        restrictToMyDrive: "true",
        includeRemoved: "false",
        spaces: "drive",
        fields,
      },
    });

    const changes = Array.isArray(resp.changes) ? resp.changes : [];

    for (const ch of changes) {
      if (!ch || ch.removed || !ch.file) continue;

      const f = ch.file;
      if (f.trashed) continue;

      const parents = Array.isArray(f.parents) ? f.parents : [];
      const inFolder = parents.includes(folderId);
      if (!inFolder) continue;

      const changeTimeMs = Date.parse(ch.time || "") || 0;
      const createdTimeMs = Date.parse(f.createdTime || "") || 0;

      if (changeTimeMs > maxChangeTimeMs) maxChangeTimeMs = changeTimeMs;

      // "Real new file" filter (creation/upload-ish, not move)
      if (!createdTimeMs || !changeTimeMs) continue;
      const lag = changeTimeMs - createdTimeMs;
      if (lag < 0 || lag > NEW_FILE_MAX_LAG_MS) continue;

      const fileId = f.id || ch.fileId;
      if (!fileId) continue;

      if (recentEmitted[fileId]) continue; // Worker-side fileId dedupe

      const payload = {
        fileId,
        name: f.name || null,
        mimeType: f.mimeType || null,
        webViewLink: f.webViewLink || null,
        createdTime: f.createdTime || null,
        folderId,
        dedupeKey: `drive:file:${fileId}`,
        watch: {
          channelId: state.channelId,
          resourceId: state.resourceId,
          messageNumber: msgNoStr || null,
        },
        emittedAt: new Date().toISOString(),
      };

      const ok = await postToN8n(env, payload);
      if (ok) {
        recentEmitted[fileId] = nowMs();
        emitted.push(fileId);
      }
    }

    nextPageToken = resp.nextPageToken || null;

    if (nextPageToken) {
      pageToken = nextPageToken;
      continue;
    }

    // End of changes stream: prefer newStartPageToken for next time
    if (resp.newStartPageToken) {
      pageToken = resp.newStartPageToken;
    }
    break;
  }

  // Persist updated state
  const nextState = {
    ...state,
    pageToken,
    lastMessageNumber: msgNo !== null ? msgNo.toString() : state.lastMessageNumber || null,
    lastMaxChangeTimeMs: maxChangeTimeMs || state.lastMaxChangeTimeMs || null,
    recentEmitted: pruneRecentEmitted(recentEmitted),
    inFlightUntilMs: 0,
  };
  await putState(env, nextState);

  return { ok: true, emittedCount: emitted.length, emittedFileIds: emitted };
}

async function postToN8n(env, payload) {
  const r = await fetch(env.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-token": env.N8N_SHARED_SECRET,
      "x-intake-event": "drive.new_file_in_folder.v1",
    },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

async function renewIfNeeded(env) {
  const state = await getState(env);
  if (!state?.pushUrl) return;

  const exp = state.expirationMs ? Number(state.expirationMs) : null;
  if (!exp) return;

  if (nowMs() > exp - RENEW_IF_EXPIRES_WITHIN_MS) {
    await setupOrRenewWatch(env, state.pushUrl, { forceRenew: true });
  }
}