// Snipper backup: downloads every account, profile, comment, like and video from your Netlify site.
// Usage (Node 18+):   npm install @netlify/blobs
//                     SITE_ID=xxxx NETLIFY_TOKEN=yyyy node export-snipper.mjs
// Result: a folder "snipper-backup" with  data/*.json,  videos/<id>.<ext>  and  manifest.json
// Optional: also upload the backup to a PRIVATE GitHub repo (as a "release", files up to 2 GB each):
//   add  GITHUB_TOKEN=ghp_...  GITHUB_REPO=yourname/snipper-backup   (repo must already exist, with at least a README)
//   the token needs "Contents: read and write" on that repo (fine-grained token) or the "repo" scope (classic).
import fs from "node:fs/promises";
import path from "node:path";

const EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function keysOf(store) {
  const out = [], r = store.list({ paginate: true });
  if (r && r[Symbol.asyncIterator]) { for await (const page of r) for (const b of page.blobs) out.push(b.key); }
  else for (const b of (await r).blobs) out.push(b.key);
  return out;
}

export async function exportAll(getStore, outDir, log = console.log) {
  const [db, users, assets] = ["db", "users", "assets"].map(n => getStore(n));
  const man = { exportedAt: new Date().toISOString(), docs: 0, users: 0, files: 0, bytes: 0, missing: [] };
  await fs.mkdir(path.join(outDir, "data"), { recursive: true });
  await fs.mkdir(path.join(outDir, "videos"), { recursive: true });

  // 1) database documents (profiles, videos, likes, follows, comments, views)
  const all = {};
  for (const k of await keysOf(db)) { const [col, id] = k.split("/"); (all[col] ||= {})[id] = await db.get(k, { type: "json" }); man.docs++; }
  for (const [col, docs] of Object.entries(all)) await fs.writeFile(path.join(outDir, "data", col + ".json"), JSON.stringify(docs, null, 1));
  log(`database: ${man.docs} documents`);

  // 2) accounts (email + password hash; keep this file private!)
  const acc = {};
  for (const k of await keysOf(users)) { acc[k] = await users.get(k, { type: "json" }); man.users++; }
  await fs.writeFile(path.join(outDir, "data", "users-PRIVATE.json"), JSON.stringify(acc, null, 1));
  log(`accounts: ${man.users} records`);

  // 3) uploaded files (videos, thumbnails, avatars, banners) are stored in chunks: put them back together
  const keys = await keysOf(assets), metas = keys.filter(k => k.endsWith(".meta"));
  for (const mk of metas) {
    const id = mk.slice(0, -5), meta = await assets.get(mk, { type: "json" });
    const file = path.join(outDir, "videos", id + "." + (EXT[meta.type] || "bin"));
    const fh = await fs.open(file, "w");
    try {
      for (let i = 0; i < (meta.parts || 1); i++) {
        const buf = await assets.get(id + "." + i, { type: "arrayBuffer" });
        if (!buf) { man.missing.push(id + "." + i); continue; }
        await fh.write(new Uint8Array(buf)); man.bytes += buf.byteLength;
      }
    } finally { await fh.close(); }
    man.files++; log(`file ${man.files}/${metas.length}: ${path.basename(file)} (${(meta.size / 1048576).toFixed(1)} MB)`);
  }
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(man, null, 1));
  log(`done: ${man.docs} docs, ${man.users} accounts, ${man.files} files, ${(man.bytes / 1048576).toFixed(1)} MB` + (man.missing.length ? `, ${man.missing.length} MISSING parts` : ""));
  return man;
}

export async function pushToGithub(dir, repo, token, fetchFn = fetch, log = console.log) {
  const H = { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "snipper-backup" };
  const tag = "backup-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let r = await fetchFn(`https://api.github.com/repos/${repo}/releases`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ tag_name: tag, name: "Snipper backup " + tag, body: "Automatic Snipper backup", draft: false }) });
  if (!r.ok) throw new Error("GitHub release failed: " + r.status + " " + (await r.text()).slice(0, 200));
  const rel = await r.json(), files = [];
  for (const sub of ["data", "videos"]) for (const f of await fs.readdir(path.join(dir, sub))) files.push([path.join(dir, sub, f), sub === "data" ? "data-" + f : f]);
  files.push([path.join(dir, "manifest.json"), "manifest.json"]);
  let n = 0;
  for (const [file, name] of files) {
    const body = await fs.readFile(file), type = name.endsWith(".json") ? "application/json" : "application/octet-stream";
    const up = rel.upload_url.replace(/\{.*$/, "") + "?name=" + encodeURIComponent(name);
    r = await fetchFn(up, { method: "POST", headers: { ...H, "content-type": type, "content-length": String(body.length) }, body });
    if (!r.ok) throw new Error(`upload of ${name} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    log(`github ${++n}/${files.length}: ${name}`);
  }
  log("uploaded to " + rel.html_url);
  return rel.html_url;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("export-snipper.mjs")) {
  const siteID = process.env.SITE_ID, token = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) { console.error("Set SITE_ID and NETLIFY_TOKEN first (see the top of this file)."); process.exit(1); }
  const { getStore } = await import("@netlify/blobs");
  const man = await exportAll(name => getStore({ name, siteID, token, consistency: "strong" }), "snipper-backup");
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    if (man.missing.length) console.warn("Warning: some parts were missing, uploading anyway.");
    await pushToGithub("snipper-backup", process.env.GITHUB_REPO, process.env.GITHUB_TOKEN);
  }
}
