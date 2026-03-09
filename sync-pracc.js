/**
 * sync-pracc.js
 * Scrapes pracc.gg and syncs upcoming matches to your Racker tracker.
 *
 * Reads config from environment variables (set as GitHub Secrets).
 * Can also be run locally — just set the vars first:
 *
 *   Windows:  set TRACKER_URL=https://... && node sync-pracc.js
 *   Mac/Linux: TRACKER_URL=https://... node sync-pracc.js
 */

const puppeteer = require("puppeteer");

// ── Config from environment variables ──
const CONFIG = {
  TRACKER_URL:      process.env.TRACKER_URL      || "https://tracker2-ten.vercel.app",
  TRACKER_USERNAME: process.env.TRACKER_USERNAME || "admin",
  TRACKER_PASSWORD: process.env.TRACKER_PASSWORD || "",
  PRACC_EMAIL:      process.env.PRACC_EMAIL      || "",
  PRACC_PASSWORD:   process.env.PRACC_PASSWORD   || "",
  MONTHS_AHEAD:     parseInt(process.env.MONTHS_AHEAD || "2"),
  // Always headless in CI, set DEBUG=true locally to watch the browser
  DEBUG: process.env.DEBUG === "true",
};

const PRACC_COLOR = "#ff7043";

// ── Tracker API helpers ──
async function getTrackerToken() {
  const res = await fetch(`${CONFIG.TRACKER_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: CONFIG.TRACKER_USERNAME,
      password: CONFIG.TRACKER_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`Tracker login failed: ${JSON.stringify(data)}`);
  console.log("✓ Logged into tracker");
  return data.token;
}

async function getExistingEvents(token) {
  const res = await fetch(`${CONFIG.TRACKER_URL}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function postEvent(token, event) {
  const res = await fetch(`${CONFIG.TRACKER_URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
  return res.json();
}

async function deleteEvent(token, id) {
  await fetch(`${CONFIG.TRACKER_URL}/api/events/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Pracc scraper ──
async function scrapePracc() {
  console.log("🌐 Launching browser...");
  const browser = await puppeteer.launch({
    headless: !CONFIG.DEBUG,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // important for GitHub Actions
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // Pretend to be a real browser
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  try {
    // ── Step 1: Login ──
    console.log("🔐 Logging into pracc.gg...");
    await page.goto("https://pracc.com/login", { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for the LOGIN WITH EMAIL button to appear
    await page.waitForSelector('button', { timeout: 15000 });
    await page.screenshot({ path: "pracc-login.png", fullPage: true });

    // Step 1: Click "LOGIN WITH EMAIL" to reveal the email/password fields
    console.log("  Clicking LOGIN WITH EMAIL...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent.trim().toUpperCase().includes('LOGIN WITH EMAIL'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "pracc-login-2.png", fullPage: true });

    // Step 2: Fill email
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    const emailEl = await page.$('input[type="email"]') || await page.$('input[name="email"]');
    if (!emailEl) throw new Error("Email input not found after clicking LOGIN WITH EMAIL");
    await emailEl.click({ clickCount: 3 });
    await emailEl.type(CONFIG.PRACC_EMAIL, { delay: 40 });
    console.log("  Filled email");

    // Step 3: Fill password
    const pwEl = await page.$('input[type="password"]');
    if (!pwEl) throw new Error("Password input not found");
    await pwEl.click({ clickCount: 3 });
    await pwEl.type(CONFIG.PRACC_PASSWORD, { delay: 40 });
    console.log("  Filled password");

    // Step 4: Submit via Enter
    await pwEl.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(()=>{});
    await page.screenshot({ path: "pracc-after-login.png", fullPage: true });

    // Check login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes("login")) {
      throw new Error("pracc.gg login failed — check your PRACC_EMAIL and PRACC_PASSWORD");
    }
    console.log("✓ Logged into pracc.gg");

    // ── Step 2: Go to Matches ──
    console.log("📅 Loading matches calendar...");
    await page.goto("https://pracc.com/matches", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(3000);

    const allMatches = [];
    const today = new Date();

    for (let mo = 0; mo <= CONFIG.MONTHS_AHEAD; mo++) {
      const targetDate = new Date(today.getFullYear(), today.getMonth() + mo, 1);
      const monthLabel = targetDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      console.log(`\n  📆 Scraping ${monthLabel}...`);

      // Navigate to next month if needed
      if (mo > 0) {
        // Try common "next month" button selectors
        const nextSelectors = [
          'button[aria-label="Next month"]',
          'button[aria-label="next month"]',
          '[data-testid="next-month"]',
          '.fc-next-button',
          'button:has(svg[data-icon="chevron-right"])',
          // Generic: button containing > or › near the month header
        ];
        let clicked = false;
        for (const sel of nextSelectors) {
          try {
            await page.click(sel);
            clicked = true;
            break;
          } catch (_) {}
        }
        if (!clicked) {
          // Fallback: find button by position (right arrow near month header)
          clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const nextBtn = buttons.find(b => {
              const txt = b.textContent.trim();
              return txt === ">" || txt === "›" || txt === "→" || b.innerHTML.includes("chevron-right");
            });
            if (nextBtn) { nextBtn.click(); return true; }
            return false;
          });
        }
        if (!clicked) console.warn("  ⚠️ Could not find next month button");
        await page.waitForTimeout(2000);
      }

      // ── Step 3: Extract matches from the page ──
      const monthMatches = await page.evaluate((yr, mo) => {
        const results = [];
        const monthStr = String(mo + 1).padStart(2, "0");

        // Strategy 1: look for data-date attributes
        document.querySelectorAll("[data-date]").forEach(el => {
          const dateAttr = el.getAttribute("data-date");
          if (!dateAttr) return;
          // Find child elements that look like match entries
          el.querySelectorAll("[class*='match'], [class*='event'], [class*='scrim']").forEach(entry => {
            const text = entry.innerText?.trim();
            if (!text) return;
            const timeMatch = text.match(/(\d{1,2}:\d{2})/);
            if (!timeMatch) return;
            const time = timeMatch[1];
            let title = text.replace(/\d{1,2}:\d{2}\s*[-–]?\s*/, "").trim();
            // Extract map from end: "Opponent - Map"
            const mapRx = /\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i;
            title = title.replace(mapRx, m => m.replace(/\s*[-–]\s*/, " — ")).trim();
            if (title.length > 1) results.push({ date: dateAttr, time, title });
          });
        });

        // Strategy 2: look for text lines matching "HH:MM - Opponent - Map"
        const allText = document.body.innerText;
        const lines = allText.split("\n").map(l => l.trim()).filter(Boolean);

        // Find date context lines and match entries below them
        const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
        let currentDate = null;

        for (const line of lines) {
          // Date header? e.g. "Monday, March 9th 2026" or "9" (day number)
          const fullDate = line.match(/([a-z]+),?\s+([a-z]+)\s+(\d+)(?:st|nd|rd|th)?\s+(\d{4})/i);
          if (fullDate) {
            const mi = months.indexOf(fullDate[2].toLowerCase());
            if (mi >= 0) {
              const dd = String(parseInt(fullDate[3])).padStart(2, "0");
              const mm = String(mi + 1).padStart(2, "0");
              currentDate = `${fullDate[4]}-${mm}-${dd}`;
            }
            continue;
          }

          // Match entry? e.g. "19:00 - NAOS | HK/SG - Split"
          const entryRx = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
          if (entryRx && currentDate) {
            const time = entryRx[1];
            let rest = entryRx[2].trim();
            const mapRx = /^(.+?)\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i;
            const mapMatch = rest.match(mapRx);
            const title = mapMatch ? `${mapMatch[1].trim()} — ${mapMatch[2]}` : rest;
            if (title.length > 1) results.push({ date: currentDate, time, title });
          }
        }

        // Deduplicate
        const seen = new Set();
        return results.filter(r => {
          const k = `${r.date}|${r.time}|${r.title}`;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
      }, targetDate.getFullYear(), targetDate.getMonth());

      console.log(`    Found ${monthMatches.length} matches`);
      allMatches.push(...monthMatches);

      // ── Step 4: Click each day to expand "+N more" entries ──
      const expandedMatches = await expandDayCells(page, targetDate);
      allMatches.push(...expandedMatches);
    }

    await browser.close();

    // Final dedup across all months
    const seen = new Set();
    return allMatches.filter(m => {
      const k = `${m.date}|${m.time}|${m.title}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });

  } catch (err) {
    if (CONFIG.DEBUG) {
      await page.screenshot({ path: "pracc-error.png" });
      console.log("  Screenshot saved to pracc-error.png");
    }
    await browser.close();
    throw err;
  }
}

async function expandDayCells(page, targetDate) {
  const matches = [];
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth();

  // Find all "+N more" overflow links and click them
  const overflowLinks = await page.$$('[class*="more"], [class*="overflow"], a:has-text("+")');
  for (const link of overflowLinks) {
    try {
      const text = await link.evaluate(el => el.textContent.trim());
      if (!text.match(/\+\d+/)) continue;

      await link.click();
      await page.waitForTimeout(500);

      // Find the popup/modal that appeared
      const popup = await page.$('[class*="popup"], [class*="modal"], [class*="expanded"], [class*="dropdown"]');
      if (!popup) continue;

      const popupMatches = await popup.evaluate((el, yr, mo) => {
        const results = [];
        const lines = el.innerText.split("\n").map(l => l.trim()).filter(Boolean);
        const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
        let dateStr = null;

        for (const line of lines) {
          const fullDate = line.match(/([a-z]+),?\s+([a-z]+)\s+(\d+)(?:st|nd|rd|th)?\s+(\d{4})/i);
          if (fullDate) {
            const mi = months.indexOf(fullDate[2].toLowerCase());
            if (mi >= 0) {
              const dd = String(parseInt(fullDate[3])).padStart(2, "0");
              const mm = String(mi + 1).padStart(2, "0");
              dateStr = `${fullDate[4]}-${mm}-${dd}`;
            }
            continue;
          }
          const entryRx = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
          if (entryRx && dateStr) {
            const time = entryRx[1];
            let rest = entryRx[2].trim();
            const mapRx = /^(.+?)\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i;
            const mapMatch = rest.match(mapRx);
            const title = mapMatch ? `${mapMatch[1].trim()} — ${mapMatch[2]}` : rest;
            if (title.length > 1) results.push({ date: dateStr, time, title });
          }
        }
        return results;
      }, yr, mo);

      matches.push(...popupMatches);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    } catch (_) {}
  }
  return matches;
}

// ── Main ──
async function sync() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("   Pracc → Racker  |  Auto Sync");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (!CONFIG.PRACC_EMAIL || !CONFIG.PRACC_PASSWORD) {
    throw new Error("PRACC_EMAIL and PRACC_PASSWORD must be set");
  }
  if (!CONFIG.TRACKER_PASSWORD) {
    throw new Error("TRACKER_PASSWORD must be set");
  }

  const token = await getTrackerToken();
  const praccMatches = await scrapePracc();

  if (praccMatches.length === 0) {
    console.log("\n⚠️  No matches scraped. Things to check:");
    console.log("   - Are your pracc credentials correct?");
    console.log("   - Does your team have matches scheduled?");
    console.log("   - Run locally with DEBUG=true to watch the browser");
    return;
  }

  console.log(`\n✓ Scraped ${praccMatches.length} total matches`);

  // Remove old future Pracc events (clean re-sync)
  const existing = await getExistingEvents(token);
  const today = new Date().toISOString().slice(0, 10);
  const oldPracc = existing.filter(e => e.cat === "Pracc" && e.date >= today);

  if (oldPracc.length > 0) {
    console.log(`🗑  Removing ${oldPracc.length} old Pracc events...`);
    for (const ev of oldPracc) await deleteEvent(token, ev.id);
  }

  // Add new ones
  let added = 0;
  console.log("➕ Syncing matches to tracker...\n");
  for (const m of praccMatches) {
    if (m.date < today) continue; // skip past matches
    const r = await postEvent(token, {
      title: m.title,
      date:  m.date,
      time:  m.time,
      cat:   "Pracc",
      color: PRACC_COLOR,
    });
    if (r.id) {
      console.log(`  ✓ ${m.date}  ${m.time}  ${m.title}`);
      added++;
    }
  }

  console.log(`\n🎉 Done! ${added} matches synced to your tracker calendar.\n`);
}

sync().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
