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
  DEBUG: process.env.DEBUG === "true",
};

const PRACC_COLOR = "#ff7043";

const MAPS = ["Split","Haven","Bind","Breeze","Fracture","Icebox","Lotus","Abyss","Sunset","Ascent","Pearl","Corrode"];
const MAP_RX = new RegExp(`^(.+?)\\s*[-–]\\s*(${MAPS.join("|")})$`, "i");

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

// ── Parse a time+title line ──
function parseEntryLine(line, dateStr) {
  const m = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
  if (!m) return null;
  const time = m[1];
  const rest = m[2].trim();
  if (/^\+\d+/.test(rest)) return null; // skip "+N more" lines
  const mm = rest.match(MAP_RX);
  const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
  if (title.length < 2) return null;
  return { date: dateStr, time, title };
}

// ── Try to click "next month" button ──
async function clickNextMonth(page) {
  const nextSelectors = [
    'button[aria-label="Next month"]',
    'button[aria-label="next month"]',
    '[data-testid="next-month"]',
    '.fc-next-button',
    'button:has(svg[data-icon="chevron-right"])',
  ];
  for (const sel of nextSelectors) {
    try { await page.click(sel); return true; } catch (_) {}
  }
  // Fallback: find by text/icon
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const btn = buttons.find(b => {
      const txt = b.textContent.trim();
      return txt === ">" || txt === "›" || txt === "→" || b.innerHTML.includes("chevron-right");
    });
    if (btn) { btn.click(); return true; }
    return false;
  });
  return clicked;
}

// ── Scrape all events from a single day popup ──
async function readPopup(page, dateStr) {
  return page.evaluate((dateStr, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];

    // Find the most relevant visible popup/overlay
    const candidates = Array.from(document.querySelectorAll("*")).filter(el => {
      if (!el.innerText) return false;
      const s = window.getComputedStyle(el);
      const vis = s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      if (!vis) return false;
      const hasTime = /\d{1,2}:\d{2}/.test(el.innerText);
      const isOverlay = s.position === "absolute" || s.position === "fixed" || parseInt(s.zIndex) > 5;
      return hasTime && isOverlay && el.offsetWidth > 80 && el.offsetHeight > 30;
    });

    // Pick the smallest matching element (most specific popup)
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const popup = candidates[0];
    if (!popup) return results;

    // Grab match URLs from anchor tags inside popup
    const links = Array.from(popup.querySelectorAll("a[href]")).map(a => ({
      text: a.innerText.trim(),
      href: a.href,
    }));

    const lines = popup.innerText.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
      if (!m) continue;
      const time = m[1];
      const rest = m[2].trim();
      if (/^\+\d+/.test(rest)) continue;
      const mm = rest.match(mapRx);
      const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
      if (title.length < 2) continue;

      // Try to find the match URL from anchor tags
      const matchLink = links.find(l =>
        l.text.includes(time) || l.text.includes(rest.slice(0, 12))
      );

      results.push({ date: dateStr, time, title, url: matchLink?.href || null });
    }
    return results;
  }, dateStr, MAP_RX.source);
}

// ── Scrape all events directly from visible calendar cells (no popup needed) ──
async function scrapeVisibleCells(page, year) {
  return page.evaluate((yr, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];

    // Strategy 1: [data-date] cells
    document.querySelectorAll("[data-date]").forEach(cell => {
      const date = cell.getAttribute("data-date");
      if (!date || !date.startsWith(String(yr))) return;

      // Get all anchor/text content inside the cell
      const links = Array.from(cell.querySelectorAll("a[href]")).map(a => ({
        text: a.innerText.trim(),
        href: a.href,
      }));

      (cell.innerText || "").split("\n").forEach(line => {
        line = line.trim();
        const m = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
        if (!m) return;
        const time = m[1];
        const rest = m[2].trim();
        if (/^\+\d+/.test(rest)) return;
        const mm = rest.match(mapRx);
        const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
        if (title.length < 2) return;
        const matchLink = links.find(l => l.text.includes(time) || l.text.includes(rest.slice(0, 12)));
        results.push({ date, time, title, url: matchLink?.href || null });
      });
    });

    // Strategy 2: elements with data-event or similar attributes
    const eventSelectors = [
      "[data-event-id]", "[data-event]", ".fc-event", ".fc-daygrid-event",
      "[class*='event']", "[class*='match']", "[class*='scrim']",
    ];
    for (const sel of eventSelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const text = el.innerText?.trim();
          if (!text || !/\d{1,2}:\d{2}/.test(text)) return;

          // Try to find the date from a parent with data-date
          let dateEl = el.closest("[data-date]");
          let date = dateEl?.getAttribute("data-date");

          // Fallback: look for date in a sibling or nearby element
          if (!date) {
            const parent = el.parentElement;
            if (parent) {
              const dateText = parent.querySelector("[data-date]")?.getAttribute("data-date");
              if (dateText) date = dateText;
            }
          }
          if (!date || !date.startsWith(String(yr))) return;

          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            const m = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
            if (!m) continue;
            const time = m[1];
            const rest = m[2].trim();
            if (/^\+\d+/.test(rest)) continue;
            const mm = rest.match(mapRx);
            const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
            if (title.length < 2) continue;
            const url = el.closest("a[href]")?.href || el.querySelector("a[href]")?.href || null;
            results.push({ date, time, title, url });
          }
        });
      } catch (_) {}
    }

    return results;
  }, year, MAP_RX.source);
}

// ── Click every day cell and read its popup to get ALL events (including hidden ones) ──
async function scrapeByClickingDays(page, targetDate) {
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const matches = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dd = String(day).padStart(2, "0");
    const mm = String(mo + 1).padStart(2, "0");
    const dateStr = `${yr}-${mm}-${dd}`;

    try {
      // Find and click the day cell
      const clicked = await page.evaluate((dayNum, dateStr) => {
        // Try [data-date] cell first
        const byDate = document.querySelector(`[data-date="${dateStr}"]`);
        if (byDate) { byDate.click(); return true; }

        // Fallback: find by day number text in a calendar cell
        const allEls = Array.from(document.querySelectorAll("td, [role='gridcell'], [class*='day'], [class*='cell']"));
        const el = allEls.find(e => {
          if (e.children.length > 5) return false;
          return e.textContent.trim().startsWith(String(dayNum));
        });
        if (el) { el.click(); return true; }
        return false;
      }, day, dateStr);

      if (!clicked) continue;
      await new Promise(r => setTimeout(r, 600));

      const popupMatches = await readPopup(page, dateStr);
      if (popupMatches.length > 0) {
        console.log(`    ${dateStr}: ${popupMatches.length} match(es) from popup`);
        matches.push(...popupMatches);
      }

      // Close popup
      await page.keyboard.press("Escape");
      await new Promise(r => setTimeout(r, 300));
    } catch (_) {}
  }

  return matches;
}

// ── Main Pracc scraper ──
async function scrapePracc() {
  console.log("🌐 Launching browser...");
  const browser = await puppeteer.launch({
    headless: !CONFIG.DEBUG,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  try {
    // ── Login ──
    console.log("🔐 Logging into pracc.gg...");
    await page.goto("https://pracc.com/login", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("button", { timeout: 15000 });

    if (CONFIG.DEBUG) await page.screenshot({ path: "pracc-login.png", fullPage: true });

    // Click "LOGIN WITH EMAIL"
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button"))
        .find(b => b.textContent.trim().toUpperCase().includes("LOGIN WITH EMAIL"));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    // Fill credentials
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
    const emailEl = await page.$('input[type="email"]') || await page.$('input[name="email"]');
    if (!emailEl) throw new Error("Email input not found");
    await emailEl.click({ clickCount: 3 });
    await emailEl.type(CONFIG.PRACC_EMAIL, { delay: 40 });

    const pwEl = await page.$('input[type="password"]');
    if (!pwEl) throw new Error("Password input not found");
    await pwEl.click({ clickCount: 3 });
    await pwEl.type(CONFIG.PRACC_PASSWORD, { delay: 40 });
    await pwEl.press("Enter");

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    if (CONFIG.DEBUG) await page.screenshot({ path: "pracc-after-login.png", fullPage: true });

    if (page.url().includes("login")) {
      throw new Error("pracc.gg login failed — check your PRACC_EMAIL and PRACC_PASSWORD");
    }
    console.log("✓ Logged into pracc.gg");

    // ── Navigate to Matches ──
    console.log("📅 Loading matches calendar...");
    await page.goto("https://pracc.com/matches", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    if (CONFIG.DEBUG) await page.screenshot({ path: "pracc-matches.png", fullPage: true });

    const allMatches = [];
    const today = new Date();

    for (let mo = 0; mo <= CONFIG.MONTHS_AHEAD; mo++) {
      const targetDate = new Date(today.getFullYear(), today.getMonth() + mo, 1);
      const monthLabel = targetDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      console.log(`\n  📆 Scraping ${monthLabel}...`);

      if (mo > 0) {
        const moved = await clickNextMonth(page);
        if (!moved) console.warn("  ⚠️  Could not find next month button");
        await new Promise(r => setTimeout(r, 2000));
      }

      // ── Strategy 1: scrape directly visible calendar cells ──
      const visibleMatches = await scrapeVisibleCells(page, targetDate.getFullYear());
      console.log(`    ${visibleMatches.length} match(es) from visible cells`);

      // ── Strategy 2: click every day cell to reveal hidden/overflow events ──
      const clickMatches = await scrapeByClickingDays(page, targetDate);
      console.log(`    ${clickMatches.length} match(es) from day popups`);

      // ── Strategy 3: click any remaining "+N more" buttons ──
      const moreBtnCount = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*"))
          .filter(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()))
          .length
      );

      const moreMatches = [];
      if (moreBtnCount > 0) {
        console.log(`    Clicking ${moreBtnCount} "+more" button(s)...`);
        for (let i = 0; i < moreBtnCount; i++) {
          try {
            // Re-query each time because DOM can change after popup close
            const btn = await page.evaluateHandle((idx) => {
              return Array.from(document.querySelectorAll("*"))
                .filter(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()))[idx];
            }, i);

            if (!btn) continue;

            // Get date context from parent cell
            const dateStr = await page.evaluate(el => {
              const cell = el?.closest("[data-date]");
              return cell ? cell.getAttribute("data-date") : null;
            }, btn);

            await btn.asElement()?.click();
            await new Promise(r => setTimeout(r, 700));

            const popupMatches = await readPopup(page, dateStr || "unknown");
            moreMatches.push(...popupMatches.filter(m => m.date !== "unknown"));

            await page.keyboard.press("Escape");
            await new Promise(r => setTimeout(r, 400));
          } catch (e) {
            console.log(`    +more[${i}] error: ${e.message}`);
          }
        }
        console.log(`    ${moreMatches.length} match(es) from "+more" popups`);
      }

      // Merge all 3 strategies for this month
      allMatches.push(...visibleMatches, ...clickMatches, ...moreMatches);
    }

    await browser.close();

    // Deduplicate across all strategies and months
    const seen = new Set();
    const deduped = allMatches.filter(m => {
      const k = `${m.date}|${m.time}|${m.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`\n✓ Total unique matches found: ${deduped.length}`);
    return deduped;

  } catch (err) {
    await page.screenshot({ path: "pracc-error.png" }).catch(() => {});
    await browser.close();
    throw err;
  }
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
    if (m.date < today) continue;
    const r = await postEvent(token, {
      title: m.title,
      date:  m.date,
      time:  m.time,
      cat:   "Pracc",
      color: PRACC_COLOR,
      url:   m.url || null,
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
