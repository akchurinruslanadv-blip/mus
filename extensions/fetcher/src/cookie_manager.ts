// extensions/fetcher/src/cookie_manager.ts: Automatic Cookie Synchronization & Resolution
import * as path from "@std/path";
import { config } from "./config.ts";

export function ensureCookies(): string | null {
  try {
    const desktopJson = "C:\\Users\\Admin\\Desktop\\cookies.json";
    const cookiesTxt = config.cookiesPath;

    // 1. Check if desktop JSON exists
    let shouldConvert = false;
    try {
      const jsonStat = Deno.statSync(desktopJson);
      try {
        const txtStat = Deno.statSync(cookiesTxt);
        // If JSON is newer or txt is empty, reconvert
        if (jsonStat.mtime && txtStat.mtime && jsonStat.mtime > txtStat.mtime) {
          shouldConvert = true;
        } else if (txtStat.size < 50) {
          shouldConvert = true;
        }
      } catch {
        // cookies.txt doesn't exist
        shouldConvert = true;
      }

      if (shouldConvert) {
        const raw = Deno.readTextFileSync(desktopJson);
        const cookies = JSON.parse(raw);
        if (Array.isArray(cookies)) {
          const lines = [
            "# Netscape HTTP Cookie File",
            "# https://curl.haxx.se/rfc/cookie_spec.html",
            "# This is a generated file! Do not edit.",
            ""
          ];
          const nowSec = Math.floor(Date.now() / 1000);
          for (const c of cookies) {
            const domain = c.domain || "";
            if (domain.includes("youtube") || domain.includes("google")) {
              const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
              const p = c.path || "/";
              const secure = c.secure ? "TRUE" : "FALSE";
              const exp = Math.floor(c.expirationDate || (nowSec + 31536000));
              const name = c.name || "";
              const val = c.value || "";
              if (name) {
                lines.push(`${domain}\t${flag}\t${p}\t${secure}\t${exp}\t${name}\t${val}`);
              }
            }
          }
          Deno.writeTextFileSync(cookiesTxt, lines.join("\n") + "\n");
          console.log(`[cookies] Synchronized ${lines.length - 4} YouTube/Google cookies to ${cookiesTxt}`);
        }
      }
    } catch {
      // desktop file might not be accessible
    }

    // 2. Validate cookies.txt
    try {
      const txtStat = Deno.statSync(cookiesTxt);
      if (txtStat.isFile && txtStat.size > 50) {
        return cookiesTxt;
      }
    } catch {}

    return null;
  } catch (err) {
    console.warn("[cookies] ensureCookies error:", err);
    return null;
  }
}
