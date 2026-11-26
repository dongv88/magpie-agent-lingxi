// The community repo's `dist` branch: `tgz/<file>` and `index.json`, which
// names each plugin's version and tarball with its sha512, so magpie can
// install it when npm doesn't have the version (README's "Publishing").
//
//   node tools/synced.mjs synced <node_modules dir> [tar]
//   node tools/synced.mjs index
//
// `synced` packs every magpie plugin (a package.json with a magpie field)
// under <dir>/node_modules, @scoped ones too, and adds it to dist/index.json.
// `index` refreshes the tarballs' hashes. The tarballs go in dist/tgz/ as
// <owner>-<name>-<version>.tgz.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const DIST = join(ROOT, "dist")
const TGZ = join(DIST, "tgz")
const INDEX = join(DIST, "index.json")
const TAR = process.argv[4] || "C:\\Windows\\System32\\tar.exe"

const readJSON = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")) } catch { return fallback } }
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n")

function hashes(file) {
  const b = readFileSync(file)
  return {
    integrity: "sha512-" + createHash("sha512").update(b).digest("base64"),
    shasum: createHash("sha1").update(b).digest("hex"),
    size: b.length,
  }
}

const tgzName = (name, version) => `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`

function sourceFiles(dir) {
  const pkg = readJSON(join(dir, "package.json"), null)
  if (!pkg) return null
  const files = ["package.json"]
  for (const f of pkg.files || []) if (existsSync(join(dir, f)) && !files.includes(f)) files.push(f)
  for (const f of ["README.md", "LICENSE"]) if (existsSync(join(dir, f)) && !files.includes(f)) files.push(f)
  return { pkg, files }
}

function pack(dir, { pkg, files }) {
  mkdirSync(TGZ, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), "dist-"))
  mkdirSync(join(stage, "package"))
  for (const f of files) writeFileSync(join(stage, "package", f), readFileSync(join(dir, f)))
  const file = tgzName(pkg.name, pkg.version)
  execFileSync(TAR, ["-czf", join(stage, "out.tgz"), "-C", stage, "package"], { stdio: "inherit" })
  rmSync(join(TGZ, file), { force: true })
  writeFileSync(join(TGZ, file), readFileSync(join(stage, "out.tgz")))
  rmSync(stage, { recursive: true, force: true })
  return { file, ...hashes(join(TGZ, file)) }
}

const doc = readJSON(INDEX, { index: {}, packs: {} })
doc.index = doc.index || {}
doc.packs = doc.packs || {}

const action = process.argv[2]
if (action === "synced") {
  const root = join(process.argv[3], "node_modules")
  const dirs = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === ".bin") continue
    if (e.name.startsWith("@")) for (const s of readdirSync(join(root, e.name), { withFileTypes: true })) if (s.isDirectory()) dirs.push(join(root, e.name, s.name))
    else dirs.push(join(root, e.name))
  }
  let n = 0
  for (const dir of dirs) {
    const src = sourceFiles(dir)
    if (!src || !src.pkg.magpie) continue
    const r = pack(dir, src)
    doc.index[src.pkg.name] = { name: src.pkg.name, version: src.pkg.version, tgz: r.file, integrity: r.integrity, shasum: r.shasum, size: r.size }
    n++
    console.log(`synced ${src.pkg.name}@${src.pkg.version} -> ${r.file}`)
  }
  console.log(`${n} plugin(s)`)
} else if (action === "index") {
  for (const f of readdirSync(TGZ).filter((f) => f.endsWith(".tgz"))) doc.packs[f] = { tgz: f, ...hashes(join(TGZ, f)) }
  console.log(`${Object.keys(doc.packs).length} tarball(s)`)
} else {
  console.log("usage: synced <dir> [tar] | index")
}
mkdirSync(DIST, { recursive: true })
write(INDEX, doc)
