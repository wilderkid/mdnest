// fileurl.ts: local path <-> mdfile URL path (must mirror decode_mdfile_path_for in protocols.rs).
import { fileUrlPath, pathFromFileUrlPath, localPathOfUrl } from "../src/host/fileurl";
let fail = 0;
const eq = (a: unknown, b: unknown, m: string) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log((ok ? "PASS " : "FAIL ") + m + (ok ? "" : ` — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)); if (!ok) fail++; };
eq(fileUrlPath("/home/u/a b.png"), "home/u/a%20b.png", "linux path");
eq(fileUrlPath("C:\\Users\\张三\\OneDrive\\文档\\assets\\image-20261020.png"), "C:/Users/%E5%BC%A0%E4%B8%89/OneDrive/%E6%96%87%E6%A1%A3/assets/image-20261020.png", "windows CJK path");
eq(fileUrlPath("C:\\notes\\C#\\a?.png"), "C:/notes/C%23/a%3F.png", "# and ? encoded (encodeURI left them raw)");
eq(fileUrlPath("\\\\?\\C:\\x\\a.png"), "C:/x/a.png", "verbatim prefix dropped");
eq(fileUrlPath("\\\\nas\\share\\a.png"), "UNC/nas/share/a.png", "UNC share");
eq(fileUrlPath("\\\\?\\UNC\\nas\\share\\a.png"), "UNC/nas/share/a.png", "verbatim UNC");
eq(fileUrlPath("C:\\Users\\x\\docs/assets/a.png"), "C:/Users/x/docs/assets/a.png", "mixed separators (doc dir + relative asset)");
for (const [p, win] of [["C:\\Users\\张三\\a#1.png", true], ["/home/u/a b.png", false], ["\\\\nas\\share\\x.png", true]] as const)
  eq(pathFromFileUrlPath(fileUrlPath(p), win), p, "round trip " + p);
eq(localPathOfUrl("http://mdfile.localhost/C:/x/a%20b.png", true), "C:\\x\\a b.png", "windows url → path");
eq(localPathOfUrl("mdfile://localhost/home/u/a.png", false), "/home/u/a.png", "linux url keeps leading /");
eq(localPathOfUrl("/fs/home/u/a.png", false), "/home/u/a.png", "browser host");
eq(localPathOfUrl("https://example.com/a.png", false), null, "remote url untouched");
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
