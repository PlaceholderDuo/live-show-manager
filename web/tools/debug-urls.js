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

  // Test 1: short URL
  console.log("=== Short URL: /tab/1720947 ===");
  await page.goto("https://tabs.ultimate-guitar.com/tab/1720947", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  
  let info = await page.evaluate(() => {
    const url = window.location.href;
    const title = document.title;
    const pres = [...document.querySelectorAll("pre")].map(p => p.innerText.length);
    const bodyText = document.body.innerText.slice(0, 500);
    return { url, title, preLengths: pres, bodyText: bodyText.slice(0, 500) };
  });
  console.log("Final URL:", info.url);
  console.log("Title:", info.title);
  console.log("Pre lengths:", JSON.stringify(info.preLengths));
  console.log("Body:", JSON.stringify(info.bodyText).slice(0, 500));

  // Test 2: full SEO URL
  console.log("\n=== Full URL: /tab/glen-campbell/gentle-on-my-mind-chords-1720947 ===");
  await page.goto("https://tabs.ultimate-guitar.com/tab/glen-campbell/gentle-on-my-mind-chords-1720947", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  info = await page.evaluate(() => {
    const url = window.location.href;
    const title = document.title;
    const pres = [...document.querySelectorAll("pre")].map(p => p.innerText.length);
    const bodyText = document.body.innerText.slice(0, 500);
    return { url, title, preLengths: pres, bodyText: bodyText.slice(0, 500) };
  });
  console.log("Final URL:", info.url);
  console.log("Title:", info.title);
  console.log("Pre lengths:", JSON.stringify(info.preLengths));
  console.log("Body:", JSON.stringify(info.bodyText).slice(0, 500));

  await browser.close();
})();
