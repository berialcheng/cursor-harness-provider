/** Build-time archive utilities. No publishing or authentication commands. */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export function isolatedNpm(temporary, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error("Use an npm run command to select the existing npm CLI");
  const home = join(temporary, "home"); mkdirSync(home, { recursive: true });
  const user = join(temporary, "user.npmrc"), global = join(temporary, "global.npmrc");
  writeFileSync(user, ""); writeFileSync(global, "");
  const env = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    npm_config_userconfig: user, npm_config_globalconfig: global,
    npm_config_cache: join(temporary, "cache"), npm_config_update_notifier: "false" };
  return { env, run(args, cwd) {
    if (!["pack", "install"].includes(args[0])) throw new Error("Only offline pack/install commands are allowed");
    return execFileSync(process.execPath, [npmCli, ...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } };
}

export function treeFiles(directory, prefix = "") {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Symlinked package tree");
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinked package entry");
    if (entry.isDirectory()) out.push(...treeFiles(path, name + "/"));
    else if (entry.isFile()) out.push(name);
    else throw new Error("Non-regular package entry");
  }
  return out.sort();
}
export function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const path of treeFiles(source)) {
    const out = join(destination, path); mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readFileSync(join(source, path)), { flag: "wx", mode: 0o644 });
  }
}
export function extractPackage(archive, destination, { maxExpandedBytes = 384 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1 || maxExpandedBytes > 384 * 1024 * 1024) {
    throw new Error("Invalid expanded archive byte budget");
  }
  // Bound the entire decompressed TAR *before* tarfile parses PAX/GNU metadata.
  // A disk-backed snapshot also avoids reparsing mutable input between passes.
  const script = [
    "import sys,tarfile,pathlib,shutil,os,json,io,gzip,tempfile",
    "destination=sys.argv[1]; limit=int(sys.argv[2])",
    "compressed=sys.stdin.buffer.read(128*1024*1024+1)",
    "if len(compressed)>128*1024*1024: raise RuntimeError('Oversized compressed tarball')",
    "root=pathlib.Path(destination)",
    "if root.exists(): raise RuntimeError('Extraction directory already exists')",
    "with tempfile.TemporaryFile() as expanded:",
    " totalRaw=0",
    " with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as gz:",
    "  while True:",
    "   chunk=gz.read(min(1024*1024,limit-totalRaw+1))",
    "   if not chunk: break",
    "   totalRaw+=len(chunk)",
    "   if totalRaw>limit: raise RuntimeError('Expanded archive byte budget exceeded')",
    "   expanded.write(chunk)",
    " expanded.seek(0)",
    " with tarfile.open(fileobj=expanded,mode='r:') as t:",
    "  members=[]; seen=set(); total=0",
    "  for m in t:",
    "   members.append(m)",
    "   if len(members)>6000: raise RuntimeError('Too many tar entries')",
    "   raw=m.name.rstrip('/'); p=pathlib.PurePosixPath(raw)",
    "   if not raw or raw.startswith('/') or '\\\\' in raw or any(x in ('','.', '..') for x in raw.split('/')) or p.parts[0]!='package': raise RuntimeError('Unsafe tar path')",
    "   if raw in seen: raise RuntimeError('Duplicate tar path')",
    "   seen.add(raw)",
    "   if not (m.isfile() or m.isdir()): raise RuntimeError('Links/devices are forbidden in tarballs')",
    "   if m.isfile() and (len(p.parts)<2 or p.parts[1] not in ('package.json','LICENSE','README.md','THIRD_PARTY_NOTICES.md','dist','native','licenses')): raise RuntimeError('Unexpected package root entry')",
    "   if any(x in ('auth.json','credentials.json','.npmrc','.env') or x.startswith('.env.') for x in p.parts): raise RuntimeError('Private tar entry')",
    "   total+=m.size",
    "   if m.size<0 or m.size>128*1024*1024 or total>384*1024*1024: raise RuntimeError('Oversized tarball')",
    "  root.mkdir(parents=True)",
    "  for m in members:",
    "   out=root.joinpath(*pathlib.PurePosixPath(m.name).parts)",
    "   if m.isdir(): out.mkdir(parents=True,exist_ok=True); continue",
    "   out.parent.mkdir(parents=True,exist_ok=True)",
    "   fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)",
    "   with os.fdopen(fd,'wb') as f, t.extractfile(m) as src: shutil.copyfileobj(src,f)",
    "print(json.dumps({'entries':len(members),'bytes':total,'expandedBytes':totalRaw}))",
  ].join("\n");
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("Invalid or oversized compressed tarball");
  execFileSync("python3", ["-c", script, destination, String(maxExpandedBytes)], {
    input: readFileSync(archive), encoding: "utf8", maxBuffer: 1024 * 1024,
    timeout: 30000, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"],
  });
  return join(destination, "package");
}
