const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const COOKIE_FILE = path.join(__dirname, "..", "logs", "ug-cookies.json");

(async () => {
  const browser = await puppeteer.launch({ headless: "new", defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  if (fs.existsSync(COOKIE_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
    await page.setCookie(...cookies);
  }

  // Intercept and log headers of authenticated API requests
  const requestHeaders = [];
  page.on("request", req => {
    const url = req.url();
    if (url.includes("api-web.ultimate-guitar.com") || url.includes("api.ultimate-guitar.com")) {
      const headers = req.headers();
      // Log auth-related headers only
      requestHeaders.push({
        url: url.slice(0, 120),
        method: req.method(),
        auth: {
          authorization: headers["authorization"] || "(none)",
          "x-ug-client-id": headers["x-ug-client-id"] || "(none)",
          "x-ug-api-key": headers["x-ug-api-key"] || "(none)",
          cookie: (headers["cookie"] || "").slice(0, 100),
          token: headers["token"] || "(none)",
          "x-token": headers["x-token"] || "(none)",
          "x-auth-token": headers["x-auth-token"] || "(none)",
        }
      });
    }
  });

  // Visit a tab page to trigger API calls
  await page.goto("https://tabs.ultimate-guitar.com/tab/zach-bryan/something-in-the-orange-chords-4012711", {
    waitUntil: "networkidle2", timeout: 30000
  });
  await new Promise(r => setTimeout(r, 3000));

  console.log("=== API request auth headers ===");
  for (const r of requestHeaders) {
    console.log(`\n${r.method} ${r.url}`);
    console.log(`  Authorization: ${r.auth.authorization}`);
    console.log(`  X-UG-CLIENT-ID: ${r.auth["x-ug-client-id"]}`);
    console.log(`  X-UG-API-KEY: ${r.auth["x-ug-api-key"]}`);
    console.log(`  Token: ${r.auth.token}`);
    console.log(`  X-Token: ${r.auth["x-token"]}`);
    console.log(`  X-Auth-Token: ${r.auth["x-auth-token"]}`);
    console.log(`  Cookie: ${r.auth.cookie}`);
  }

  // Also check: does the mobile API /list/myTab work from the browser context?
  console.log("\n\n=== Mobile API /list/myTab from browser ===");
  const mobileResult = await page.evaluate(async () => {
    // Generate mobile API headers
    const deviceId = Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('');
    const now = new Date();
    const yyyymmddhh = now.getUTCFullYear() + '-' + String(now.getUTCMonth()+1).padStart(2,'0') + '-' + String(now.getUTCDate()).padStart(2,'0') + ':' + String(now.getUTCHours()).padStart(2,'0');
    const apiKey = await crypto.subtle.digest("MD5", new TextEncoder().encode(deviceId + yyyymmddhh + "createLog()"))
      .then(b => Array.from(new Uint8Array(b)).map(b => b.toString(16).padStart(2,'0')).join(''));
    
    const res = await fetch("https://api.ultimate-guitar.com/api/v1/list/myTab", {
      headers: {
        "X-UG-CLIENT-ID": deviceId,
        "X-UG-API-KEY": apiKey,
        "User-Agent": "UGT_ANDROID/4.11.1 (Pixel; 8.1.0)",
        "Accept": "application/json"
      }
    });
    return { status: res.status, body: await res.text().then(t => t.slice(0, 500)) };
  });
  console.log("Status:", mobileResult.status);
  console.log("Body:", mobileResult.body);

  await browser.close();
})();
