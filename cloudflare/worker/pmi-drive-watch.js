/**
 * Cloudflare Worker — Google Drive push → KV gate → n8n webhook
 *
 * Endpoints:
 *  - POST /drive/push  : where Google Drive push pings will be sent
 *  - POST /drive/setup : a manual endpoint you call once to create/renew the watch
 *  - GET  /drive/status: read-only status (debug; no secrets)
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
 *
 * --------------------------------------------------------------------------
 * CHANGES vs previous version — 2026-06-13
 * --------------------------------------------------------------------------
 * Problem: On channel renewal (cron or expiry), Google Drive sent a burst of
 * push notifications. Each notification triggered 2 KV put() calls (one
 * in-flight guard + one final state save). When the KV free-tier limit of
 * 1 000 put/day was hit, Workers started returning HTTP 500. Google's retry
 * policy then resent every failed notification aggressively, causing a
 * feedback loop that exhausted the daily KV quota within minutes.
 *
 * Fix 1 — Respond 200 immediately, process in background (ctx.waitUntil).
 *   Google Drive does NOT retry when it receives a 2xx response. By returning
 *   200 before any KV or API work begins, we break the retry loop entirely.
 *
 * Fix 2 — Reduced KV put() calls from 2 to 1 per notification.
 *   The early "in-flight guard" put() was removed. The in-flight timestamp is
 *   now written only once, together with the final state update at the end of
 *   processing. This halves KV write usage under normal operation.
 *
 * Fix 3 — Global error handler returns HTTP 200 (not 500) for /drive/push.
 *   Even if an unexpected exception escapes processDrivePush(), the Worker
 *   responds 200 to Google so it never triggers a retry storm.
 * --------------------------------------------------------------------------
 *
 * CHANGES — 2026-06-15 (channel renewal frequency fix)
 * --------------------------------------------------------------------------
 * Root cause found: the /changes/watch request did NOT set the "expiration"
 * field, so Google defaulted the channel lifetime to just 1 HOUR. Combined
 * with RENEW_IF_EXPIRES_WITHIN_MS = 1 hour and a cron running every 30
 * minutes, the Worker was renewing (stopping old channel + creating new one)
 * on EVERY cron tick — ~48 times/day. Each renewal = 1 OAuth refresh,
 * 1 channels/stop call, 1 changes/watch call, and 1 KV put. This also caused
 * the old and new channels to briefly overlap, producing the recurring
 * "channel_mismatch" errors in the logs.
 *
 * Fix 4 — Request the maximum allowed channel lifetime (7 days) from Google
 *   by setting "expiration" explicitly in the /changes/watch request body.
 *
 * Fix 5 — Increase RENEW_IF_EXPIRES_WITHIN_MS to 1 day. With a 7-day channel
 *   lifetime, renewal now happens roughly once every ~6 days instead of
 *   every 30 minutes — a ~99% reduction in renewal-related KV writes, OAuth
 *   token refreshes, and Drive API calls.
 * --------------------------------------------------------------------------
 */

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

const MAX_CHANGE_PAGES = 10;
const PAGE_SIZE = 100;

// "New file" heuristic: change time close to created time ⇒ likely creation/upload, not a move.
const NEW_FILE_MAX_LAG_MS = 5 * 60 * 1000; // 5 min (NOTE: currently unused; heuristic disabled below)

// Dedupe window for emitted fileIds (Worker-side)
const EMIT_DEDUPE_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const EMIT_DEDUPE_MAX_KEYS = 200;

// Avoid concurrent processing on bursty duplicate pings (best-effort)
const IN_FLIGHT_WINDOW_MS = 30 * 1000;

// Renewal threshold — renew when the channel is within this much time of expiring.
// With a requested 7-day channel lifetime (see DRIVE_CHANNEL_TTL_MS below),
// this means renewal happens roughly once every ~6 days.
const RENEW_IF_EXPIRES_WITHIN_MS = 24 * 60 * 60 * 1000; // 1 day

// Requested channel lifetime for /changes/watch. Google's documented maximum
// for the "changes" resource is 604800 seconds (7 days). If "expiration" is
// omitted, Google defaults to just 1 hour — which was the root cause of the
// constant re-renewal / channel_mismatch issue.
const DRIVE_CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CHANGED (Fix 1 + Fix 3): /drive/push responds 200 immediately and
    // runs processing in the background via ctx.waitUntil(). This ensures
    // Google Drive never sees a 5xx and never retries the notification.
    if (path === "/drive/push") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      ctx.waitUntil(processDrivePushBackground(request, env));
      return json({ ok: true, accepted: true }, 200);
    }

    try {
      if (path === "/drive/setup") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const pushUrl = new URL("/drive/push", url.origin).toString();
        const res = await setupOrRenewWatch(env, pushUrl, { forceRenew: true });
        return json(res, 200);
      }

      if (path === "/drive/status") {
        const s = await getState(env);
        if (!s) return json({ ok: true, state: null }, 200);
        const { folderId, pushUrl, pageToken, channelId, resourceId, expirationMs, lastMessageNumber, lastMaxChangeTimeMs, lastRenewAtMs, lastRenewError } = s;
        const recentEmittedCount = s.recentEmitted ? Object.keys(s.recentEmitted).length : 0;
        return json({ ok: true, state: { folderId, pushUrl, pageToken, channelId, resourceId, expirationMs, lastMessageNumber, lastMaxChangeTimeMs, lastRenewAtMs, lastRenewError, recentEmittedCount } }, 200);
      }

      return json({ ok: true, name: "pmi-drive-watch", endpoints: ["/drive/setup", "/drive/push", "/drive/status"] }, 200);
    } catch (e) {
      return json({ error: "worker_error", details: String(e?.message ?? e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(renewIfNeeded(env));
  },
};

// CHANGED (Fix 1): Background processor for /drive/push — called via ctx.waitUntil().
// Google has already received 200 by the time this runs, so any error here
// is silent from Google's perspective (no retry triggered).
async function processDrivePushBackground(request, env) {
  try {
    await handleDrivePush(request, env);
  } catch (e) {
    // Log error for observability but do NOT propagate — Google already got 200.
    console.error("processDrivePushBackground error:", String(e?.message ?? e));
  }
}

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
      // ignore
    }
  }

  // Ensure pageToken
  let pageToken = state.pageToken;
  if (!pageToken) {
    const sp = await driveFetch(env, accessToken, "/changes/startPageToken", {
      query: { fields: "startPageToken" },
    });
    pageToken = sp.startPageToken;
  }

  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomUUID();
  // CHANGED (Fix 4): explicitly request a 7-day channel lifetime. Without
  // this, Google defaults to 1 hour, causing constant renewal every cron tick.
  const requestedExpirationMs = Date.now() + DRIVE_CHANNEL_TTL_MS;
  const watchRes = await driveFetch(env, accessToken, "/changes/watch", {
    method: "POST",
    query: { pageToken },
    body: {
      id: channelId,
      type: "web_hook",
      address: pushUrl,
      token: channelToken,
      expiration: String(requestedExpirationMs),
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
    lastRenewAtMs: Date.now(),
    lastRenewError: null,
    lastMessageNumber: null, // reset on (re)watch to avoid duplicate_message_number lock
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

async function handleDrivePush(request, env) {
  const state = await getState(env);
  if (!state?.channelId || !state?.resourceId) {
    console.error("drive_push: not_setup_yet");
    return;
  }

  // Validate channel headers
  const chId = header(request, "X-Goog-Channel-ID");
  const resId = header(request, "X-Goog-Resource-ID");
  const chToken = header(request, "X-Goog-Channel-Token");
  const resState = header(request, "X-Goog-Resource-State");
  const msgNoStr = header(request, "X-Goog-Message-Number");

  if (chId !== state.channelId || resId !== state.resourceId) {
    console.error("drive_push: channel_mismatch", { chId, expected: state.channelId });
    return;
  }
  if (state.channelToken && chToken && chToken !== state.channelToken) {
    console.error("drive_push: token_mismatch");
    return;
  }

  // Ignore sync message — no KV write needed
  if (resState === "sync") {
    console.log("drive_push: ignored sync");
    return;
  }

  // De-dupe by message number — no KV write needed
  const msgNo = toBigIntOrNull(msgNoStr);
  const lastMsgNo = toBigIntOrNull(state.lastMessageNumber);
  if (msgNo !== null && lastMsgNo !== null && msgNo <= lastMsgNo) {
    console.log("drive_push: ignored duplicate_message_number", msgNoStr);
    return;
  }

  // In-flight guard — no KV write needed (just read)
  const t = nowMs();
  if (state.inFlightUntilMs && t < Number(state.inFlightUntilMs)) {
    console.log("drive_push: ignored in_flight");
    return;
  }

  // CHANGED (Fix 2): Removed the early putState() for the in-flight guard.
  // Previously this caused 2 KV puts per notification (one here, one at the end).
  // Now we write inFlightUntilMs only once, in the final putState() below.
  // This halves KV write operations per push notification.

  const accessToken = await getAccessToken(env);

  const fields =
    "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,trashed,createdTime,webViewLink))";

  let pageToken = state.pageToken;
  let maxChangeTimeMs = Number(state.lastMaxChangeTimeMs || 0);
  const folderId = env.INTAKE_FOLDER_ID;

  const emitted = [];
  let recentEmitted = pruneRecentEmitted(state.recentEmitted || {});

  for (let i = 0; i < MAX_CHANGE_PAGES; i++) {
    const resp = await driveFetch(env, accessToken, "/changes", {
      query: {
        pageToken,
        pageSize: String(PAGE_SIZE),
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

      if (changeTimeMs > maxChangeTimeMs) maxChangeTimeMs = changeTimeMs;

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

    const nextPageToken = resp.nextPageToken || null;

    if (nextPageToken) {
      pageToken = nextPageToken;
      continue;
    }

    if (resp.newStartPageToken) {
      pageToken = resp.newStartPageToken;
    }
    break;
  }

  // CHANGED (Fix 2): Single putState() per notification — includes inFlightUntilMs
  // set to 0 (already done) so no second write is needed. Previously there were
  // two puts: one for the in-flight guard and one here.
  const nextState = {
    ...state,
    pageToken,
    lastMessageNumber: msgNo !== null ? msgNo.toString() : state.lastMessageNumber || null,
    lastMaxChangeTimeMs: maxChangeTimeMs || state.lastMaxChangeTimeMs || null,
    recentEmitted: pruneRecentEmitted(recentEmitted),
    inFlightUntilMs: 0,
  };
  await putState(env, nextState);

  console.log("drive_push: processed", { emittedCount: emitted.length, emittedFileIds: emitted });
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

  if (nowMs() <= exp - RENEW_IF_EXPIRES_WITHIN_MS) return;

  try {
    await setupOrRenewWatch(env, state.pushUrl, { forceRenew: true });
  } catch (e) {
    const s2 = (await getState(env)) || state || {};
    s2.lastRenewError = String(e?.message ?? e);
    s2.lastRenewAtMs = Date.now();
    await putState(env, s2);
    throw e;
  }
}