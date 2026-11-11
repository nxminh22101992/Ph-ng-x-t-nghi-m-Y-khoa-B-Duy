const fs = require("fs");
const TMP_FILE = "/tmp/baduy_lab_sync_store.json";

function readStore() {
  try {
    if (global.__BADUY_SYNC_STORE) return global.__BADUY_SYNC_STORE;
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
      global.__BADUY_SYNC_STORE = parsed;
      return parsed;
    }
  } catch (_) {}
  return { revision: 1, reports: [], deleted: {} };
}

function writeStore(store) {
  global.__BADUY_SYNC_STORE = store;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(store), "utf8");
  } catch (_) {}
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Sync-Key");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const store = readStore();

  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      revision: store.revision || 1,
      reports: store.reports || [],
      deleted: store.deleted || {},
      data: {
        reports: store.reports || [],
        deleted: store.deleted || {}
      }
    });
  }

  if (req.method === "POST" || req.method === "PUT") {
    try {
      const incoming = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const dataObj = incoming.data || incoming;
      const incReports = Array.isArray(dataObj.reports) ? dataObj.reports : (Array.isArray(dataObj.upserts) ? dataObj.upserts : []);
      const incDeleted = (dataObj.deleted && typeof dataObj.deleted === "object") ? dataObj.deleted : {};

      const mergedDeleted = Object.assign({}, store.deleted || {}, incDeleted);
      const map = new Map();
      (store.reports || []).forEach(r => {
        if (r && r.code && !mergedDeleted[r.code]) map.set(r.code, r);
      });
      incReports.forEach(r => {
        if (!r || !r.code || mergedDeleted[r.code]) return;
        const ex = map.get(r.code);
        if (!ex || String(r.updatedAt || r.createdAt || "") >= String(ex.updatedAt || ex.createdAt || "")) {
          map.set(r.code, r);
        }
      });

      const mergedReports = Array.from(map.values()).sort((a, b) => String(b.code || "").localeCompare(String(a.code || "")));
      const newStore = {
        revision: (Number(store.revision) || 1) + 1,
        updatedAt: new Date().toISOString(),
        reports: mergedReports,
        deleted: mergedDeleted
      };
      writeStore(newStore);

      return res.status(200).json({
        ok: true,
        revision: newStore.revision,
        updatedAt: newStore.updatedAt,
        reports: mergedReports,
        deleted: mergedDeleted
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
};
