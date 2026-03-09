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
    await new Promise(r => setTimeout(r, 1500));
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
    await new Promise(r => setTimeout(r, 3000));

    const allMatches = [];
    const today = new Date();

    for (let mo = 0; mo <= CONFIG.MONTHS_AHEAD; mo++) {
      const targetDate = new Date(today.getFullYear(), today.getMonth() + mo, 1);
      const monthLabel = targetDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      console.log(`\n  📆 Scraping ${monthLabel}...`);
      if (mo === 0) await page.screenshot({ path: "pracc-matches.png", fullPage: true });

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
        await new Promise(r => setTimeout(r, 2000));
      }

      // ── Step 3: Click each "+N more" button, read its popup with date context ──
      const monthMatches = [];

      // Count how many "+more" buttons are on the page
      const moreBtnCount = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .filter(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()))
          .length
      );
      console.log(`    ${moreBtnCount} "+more" buttons to click`);

      for (let i = 0; i < moreBtnCount; i++) {
        try {
          await page.evaluate((idx) => {
            const btns = Array.from(document.querySelectorAll('*'))
              .filter(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()));
            if (btns[idx]) btns[idx].click();
          }, i);
          await new Promise(r => setTimeout(r, 700));

          // Read popup — it always contains the date header + all matches for that day
          const popup = await page.evaluate(() => {
            // The popup pracc uses contains a bold date like "Monday, March 9th 2026"
            // Find the smallest element that contains both a date and a time
            const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
              if (!el.innerText) return false;
              const t = el.innerText;
              return t.match(/[a-z]+,?\s+[a-z]+\s+\d+/i) && t.match(/\d{1,2}:\d{2}/) && el.offsetWidth > 50;
            });
            // Pick smallest matching element (most specific)
            candidates.sort((a,b) => a.innerText.length - b.innerText.length);
            return candidates[0]?.innerText || null;
          });

          if (popup) {
            const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
            const lines = popup.split("\n").map(l => l.trim()).filter(Boolean);
            let dateStr = null;
            for (const line of lines) {
              const dm = line.match(/([a-z]+),?\s+([a-z]+)\s+(\d+)(?:st|nd|rd|th)?[,\s]+(\d{4})/i);
              if (dm) {
                const mi = months.indexOf(dm[2].toLowerCase());
                if (mi >= 0) dateStr = `${dm[4]}-${String(mi+1).padStart(2,"0")}-${String(parseInt(dm[3])).padStart(2,"0")}`;
                continue;
              }
              const em = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
              if (em && dateStr) {
                const time = em[1];
                const rest = em[2].trim();
                const mm = rest.match(/^(.+?)\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i);
                const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
                if (title.length > 1) monthMatches.push({ date: dateStr, time, title });
              }
            }
          }
          await page.keyboard.press("Escape");
          await new Promise(r => setTimeout(r, 400));
        } catch(e) { console.log(`    +more ${i} error: ${e.message}`); }
      }

      // Also grab visible matches (the ones shown without needing "+more")
      const visibleMatches = await page.evaluate((yr) => {
        const results = [];
        document.querySelectorAll('[data-date]').forEach(cell => {
          const date = cell.getAttribute('data-date');
          if (!date || !date.startsWith(String(yr))) return;
          (cell.innerText || "").split("\n").forEach(line => {
            line = line.trim();
            const em = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
            if (!em) return;
            const rest = em[2].trim();
            if (/^\+\d+/.test(rest)) return; // skip "+2 more" lines
            const mm = rest.match(/^(.+?)\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i);
            const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
            if (title.length > 1) results.push({ date, time: em[1], title });
          });
        });
        return results;
      }, targetDate.getFullYear());

      monthMatches.push(...visibleMatches);
      console.log(`    Found ${monthMatches.length} matches total`);
      allMatches.push(...monthMatches);
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
  // Click each calendar day cell to trigger its popup, then read the match list
  const matches = [];
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    try {
      const dd = String(day).padStart(2, "0");
      const mm = String(mo + 1).padStart(2, "0");
      const dateStr = `${yr}-${mm}-${dd}`;

      // Click the day number cell
      const clicked = await page.evaluate((dayNum, yr, mo) => {
        // Find day cells — look for elements containing just the day number
        const allEls = Array.from(document.querySelectorAll('*'));
        const dayEl = allEls.find(el => {
          if (el.children.length > 3) return false;
          const txt = el.textContent.trim();
          return txt === String(dayNum) && el.offsetWidth > 20;
        });
        if (dayEl) { dayEl.click(); return true; }
        return false;
      }, day, yr, mo);

      if (!clicked) continue;
      await new Promise(r => setTimeout(r, 500));

      // Read the popup — look for the date header "Monday, March 9th 2026" style
      const popupMatches = await page.evaluate((dateStr) => {
        const results = [];
        const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];

        // Find the popup element — it usually contains the date as a header
        const allEls = Array.from(document.querySelectorAll('*'));
        const popup = allEls.find(el => {
          const s = window.getComputedStyle(el);
          return el.innerText?.includes(":") &&
                 (s.position === "absolute" || s.position === "fixed" || parseInt(s.zIndex) > 5) &&
                 el.offsetHeight > 40 && el.offsetWidth > 100;
        });

        const text = popup ? popup.innerText : "";
        if (!text) return results;

        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const entryRx = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
          if (entryRx) {
            const time = entryRx[1];
            let rest = entryRx[2].trim();
            const mapRx = /^(.+?)\s*[-–]\s*(Split|Haven|Bind|Breeze|Fracture|Icebox|Lotus|Abyss|Sunset|Ascent|Pearl|Corrode)$/i;
            const mapMatch = rest.match(mapRx);
            const title = mapMatch ? `${mapMatch[1].trim()} — ${mapMatch[2]}` : rest;
            if (title.length > 1) results.push({ date: dateStr, time, title });
          }
        }
        return results;
      }, dateStr);

      if (popupMatches.length > 0) {
        console.log(`    Day ${dateStr}: ${popupMatches.length} matches from popup`);
        matches.push(...popupMatches);
      }

      await page.keyboard.press("Escape");
      await new Promise(r => setTimeout(r, 300));
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
