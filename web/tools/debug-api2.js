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

  await page.goto("https://www.ultimate-guitar.com/", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Try various API endpoints to get tab data by ID
  const endpoints = [
    // api-web.ultimate-guitar.com attempts
    { url: "https://api-web.ultimate-guitar.com/v1/tab/info?tab_id=1720947", desc: "api-web tab/info" },
    { url: "https://api-web.ultimate-guitar.com/v1/tab/details?tab_id=1720947", desc: "api-web tab/details" },
    { url: "https://api-web.ultimate-guitar.com/v1/tab/data?tab_id=1720947", desc: "api-web tab/data" },
    // www.ultimate-guitar.com API attempts
    { url: "https://www.ultimate-guitar.com/api/tab/info?tab_id=1720947", desc: "www /api/tab/info" },
    { url: "https://www.ultimate-guitar.com/api/v1/tab/info?tab_id=1720947", desc: "www /api/v1/tab/info" },
    // Check what the /user/list/tab-list returns more completely
    { url: "https://www.ultimate-guitar.com/user/list/tab-list", desc: "tab-list" },
  ];

  for (const ep of endpoints) {
    try {
      const result = await page.evaluate(async (url) => {
        const res = await fetch(url);
        const text = await res.text();
        try { return { status: res.status, json: JSON.parse(text) }; }
        catch { return { status: res.status, text: text.slice(0, 300) }; }
      }, ep.url);
      console.log(`${ep.desc}: status=${result.status}`);
      if (result.json) console.log(JSON.stringify(result.json).slice(0, 500));
      if (result.text) console.log(result.text);
    } catch (e) {
      console.log(`${ep.desc}: ERROR ${e.message}`);
    }
  }

  // Also try: can we access the preloaded state on the 404 page to extract a redirect?
  console.log("\n=== Testing /tab/1720947 for redirect data ===");
  await page.goto("https://tabs.ultimate-guitar.com/tab/1720947", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  
  const pageData = await page.evaluate(() => {
    // Check for any data attributes or script payloads
    const finalUrl = window.location.href;
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent).filter(t => t && t.length > 0);
    const relevantScripts = scripts.filter(s => s.includes("tab_id") || s.includes("1720947") || s.includes("redirect") || s.includes("route"));
    return { finalUrl, relevantScripts: relevantScripts.map(s => s.slice(0, 500)) };
  });
  console.log("Final URL:", pageData.finalUrl);
  console.log("Relevant scripts:", JSON.stringify(pageData.relevantScripts).slice(0, 1000));

  await browser.close();
})();
