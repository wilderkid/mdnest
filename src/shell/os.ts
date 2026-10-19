/** body class themes key on: `os-windows` / `os-linux` / `is-mac`. */
export function osClass(ua = typeof navigator !== "undefined" ? navigator.userAgent : "", platform = typeof navigator !== "undefined" ? navigator.platform : ""): "os-windows" | "os-linux" | "is-mac" {
  const s = ua + " " + platform;
  if (/Mac|iPhone|iPad|iPod/.test(s)) return "is-mac";
  if (/Windows|Win32|Win64/.test(s)) return "os-windows";
  return "os-linux";
}

export function applyOsClass(target: HTMLElement = document.body): string {
  const c = osClass();
  target.classList.remove("os-windows", "os-linux", "is-mac");
  target.classList.add(c);
  return c;
}
