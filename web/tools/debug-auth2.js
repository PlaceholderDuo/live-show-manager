const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

puppeteer.use(StealthPlugin());

const COOKIE_FILE = path.join(__dirname, "..", "logs", "ug-cookies.json");

function generateMobileHeaders() {
  const deviceId = crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const yyyymmddhh = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}:${String(now.getUTCHours()).padStart(2,"0")}`;
  const apiKey = crypto.createHash("md5").update(`${deviceId}${yyyymmddhh}createLog()`).digest("hex");
  return { deviceId, apiKey };
}

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

  await page.goto("https://www.ultimate-guitar.com/", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Get all cookies from the browser
  const cookies = await page.cookies();
  const cookiejar = {};
  for (const c of cookies) {
    if (c.name === "bbsessionhash" || c.name === "bbuserid" || c.name === "bbpassword" || c.name === "UGSESSION" || c.name === "bbusername") {
      cookiejar[c.name] = c.value;
    }
  }
  console.log("Session cookies:", JSON.stringify(cookiejar, null, 2));

  // Try the mobile API tab/info with each cookie as the token
  const tokens = [cookiejar.bbsessionhash, cookiejar.UGSESSION, cookiejar.bbpassword, cookiejar.bbuserid].filter(Boolean);
  const { deviceId, apiKey } = generateMobileHeaders();

  for (const token of tokens) {
    const result = await page.evaluate(async ({ t, did, ak }) => {
      try {
        const res = await fetch("https://api.ultimate-guitar.com/api/v1/tab/info?tab_id=1720947&token=" + encodeURIComponent(t), {
          headers: {
            "X-UG-CLIENT-ID": did,
            "X-UG-API-KEY": ak,
            "User-Agent": "UGT_ANDROID/4.11.1 (Pixel; 8.1.0)",
            "Accept": "application/json"
          }
        });
        return { status: res.status, body: await res.text().then(t => t.slice(0, 500)) };
      } catch(e) {
        return { error: e.message };
      }
    }, { t: token, did: deviceId, ak: apiKey });
    console.log(`\nToken (${token.slice(0, 15)}...): status=${result.status}`, result.body || result.error);
  }

  // Also try: can we use the info from api-web to get tab data?
  // Try the device/create endpoint and see if we get a session
  console.log("\n=== Try device/create to get a web API session ===");
  const devResult = await page.evaluate(async () => {
    const res = await fetch("https://api-web.ultimate-guitar.com/v1/user/device/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    return { status: res.status, body: await res.text().then(t => t.slice(0, 500)) };
  });
  console.log("Status:", devResult.status, "Body:", devResult.body);

  await browser.close();
})();
