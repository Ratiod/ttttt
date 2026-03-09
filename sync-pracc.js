/**
 * sync-pracc.js
 * Scrapes pracc.gg and syncs upcoming matches to your Racker tracker.
 *
 *   Windows:  set TRACKER_URL=https://... && node sync-pracc.js
 *   Mac/Linux: TRACKER_URL=https://... node sync-pracc.js
 */

const puppeteer = require("puppeteer");

const CONFIG = {
  TRACKER_URL:      process.env.TRACKER_URL      || "https://tracker2-ten.vercel.app",
  TRACKER_USERNAME: process.env.TRACKER_USERNAME || "admin",
  TRACKER_PASSWORD: process.env.TRACKER_PASSWORD || "",
  PRACC_EMAIL:      process.env.PRACC_EMAIL      || "",
  PRACC_PASSWORD:   process.env.PRACC_PASSWORD   || "",
  MONTHS_AHEAD:     parseInt(process.env.MONTHS_AHEAD || "2"),
  DEBUG:            process.env.DEBUG === "true",
};

const PRACC_COLOR = "#ff7043";
const MAPS = ["Split","Haven","Bind","Breeze","Fracture","Icebox","Lotus","Abyss","Sunset","Ascent","Pearl","Corrode"];
const MAP_RX = new RegExp(`^(.+?)\\s*[-–]\\s*(${MAPS.join("|")})$`, "i");

// ── Tracker API ──
async function getTrackerToken() {
  const res = await fetch(`${CONFIG.TRACKER_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: CONFIG.TRACKER_USERNAME, password: CONFIG.TRACKER_PASSWORD }),
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

// ── Parse a time-title line into a match object ──
function parseLine(line, dateStr) {
  const m = line.trim().match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
  if (!m) return null;
  const time = m[1];
  const rest = m[2].trim();
  if (/^\+\d+/.test(rest)) return null;
  const mm = rest.match(MAP_RX);
  const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
  if (title.length < 2) return null;
  return { date: dateStr, time, title, url: null };
}

// ── Try clicking "next month" ──
async function clickNextMonth(page) {
  const selectors = [
    // React Big Calendar
    '.rbc-toolbar button.rbc-next',
    '.rbc-toolbar button:last-child',
    // Other common selectors
    'button[aria-label="Next month"]', 'button[aria-label="next month"]',
    '[data-testid="next-month"]', '.fc-next-button',
    'button:has(svg[data-icon="chevron-right"])',
  ];
  for (const sel of selectors) {
    try { await page.click(sel); return true; } catch (_) {}
  }
  return page.evaluate(() => {
    // rbc toolbar: "Back", "Today", "Next" — find the Next button
    const toolbar = document.querySelector(".rbc-toolbar");
    if (toolbar) {
      const btns = Array.from(toolbar.querySelectorAll("button"));
      // Next is typically the last button in the left group
      const nextBtn = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === "next" || t === ">" || t === "›" || t === "→";
      }) || btns[btns.length - 1];
      if (nextBtn) { nextBtn.click(); return true; }
    }
    // Fallback generic
    const btn = Array.from(document.querySelectorAll("button")).find(b => {
      const t = b.textContent.trim();
      return t === ">" || t === "›" || t === "→" || b.innerHTML.includes("chevron-right");
    });
    if (btn) { btn.click(); return true; }
    return false;
  });
}

// ── Read a popup that's currently open on screen ──
// dateStr is passed in so we know what date to tag matches with
async function readOpenPopup(page, dateStr) {
  return page.evaluate((dateStr, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];

    // Find the topmost visible overlay with time content
    const candidates = Array.from(document.querySelectorAll("*")).filter(el => {
      if (!el.innerText) return false;
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const isOverlay = s.position === "absolute" || s.position === "fixed" || parseInt(s.zIndex) > 5;
      return isOverlay && /\d{1,2}:\d{2}/.test(el.innerText) && el.offsetWidth > 80 && el.offsetHeight > 30;
    });
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const popup = candidates[0];
    if (!popup) return results;

    const links = Array.from(popup.querySelectorAll("a[href]")).map(a => ({
      text: a.innerText.trim(), href: a.href,
    }));

    for (const line of popup.innerText.split("\n")) {
      const m = line.trim().match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
      if (!m) continue;
      const time = m[1];
      const rest = m[2].trim();
      if (/^\+\d+/.test(rest)) continue;
      const mm = rest.match(mapRx);
      const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
      if (title.length < 2) continue;
      const link = links.find(l => l.text.includes(time) || l.text.includes(rest.slice(0, 12)));
      results.push({ date: dateStr, time, title, url: link?.href || null });
    }
    return results;
  }, dateStr, MAP_RX.source);
}

// ── Scrape one month using React Big Calendar (rbc-*) classes ──
async function scrapeMonth(page, targetDate) {
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth();
  const matches = [];

  // ── Pass 1: read all rbc-event-content elements and resolve their date
  // from the parent rbc-month-row / rbc-date-cell structure ──
  const domMatches = await page.evaluate((yr, mo, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];
    const seen = new Set();

    // Build a map of column-index → date for this calendar view.
    // rbc-month-header has rbc-header cells (Sun Mon Tue ...) — 7 columns.
    // rbc-month-row contains rbc-date-cell elements each with an <a> or button
    // whose text is the day number. We also look for data-date or aria-label.
    const getDateForCell = (eventEl) => {
      // Walk up to find the rbc-month-row
      const row = eventEl.closest(".rbc-month-row, .rbc-week-row, [class*=rbc-row]");
      if (!row) return null;

      // Find all date cells in this row
      const dateCells = Array.from(row.querySelectorAll(".rbc-date-cell, [class*=date-cell]"));
      if (dateCells.length === 0) return null;

      // Find which rbc-day-bg column the event is in
      const bgSlots = Array.from(row.querySelectorAll(".rbc-day-bg, [class*=day-bg]"));
      if (bgSlots.length === 0) return null;

      // Find the event row (rbc-row-segment) within the row
      const eventRow = eventEl.closest(".rbc-row-segment, [class*=row-segment]");
      if (!eventRow) return null;

      // Get column index of this event segment
      const allSegments = Array.from(row.querySelectorAll(".rbc-row-segment, [class*=row-segment]"));
      // Use offsetLeft to determine column
      const eventLeft = eventEl.closest(".rbc-row-segment")?.offsetLeft || 0;
      const rowLeft = row.getBoundingClientRect().left;
      const rowWidth = row.offsetWidth;
      const colWidth = rowWidth / 7;
      const colIdx = Math.round(eventLeft / colWidth);

      // Get date from the date cell at that column index
      const dateCell = dateCells[colIdx] || dateCells[0];
      if (!dateCell) return null;

      // Try data-date attribute first
      if (dateCell.dataset?.date) return dateCell.dataset.date;

      // Try aria-label like "March 10"
      const aria = dateCell.getAttribute("aria-label") || dateCell.querySelector("[aria-label]")?.getAttribute("aria-label");
      if (aria) {
        const m = aria.match(/([A-Za-z]+)\s+(\d+)/);
        if (m) {
          const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
          const mi = months.indexOf(m[1].toLowerCase());
          if (mi >= 0) {
            // Determine year based on month (handle year boundaries)
            const d = `${yr}-${String(mi+1).padStart(2,"0")}-${String(parseInt(m[2])).padStart(2,"0")}`;
            return d;
          }
        }
      }

      // Try the link text (just a number) + figure out the date from context
      const linkText = dateCell.querySelector("a, button")?.textContent?.trim();
      if (linkText && /^\d{1,2}$/.test(linkText)) {
        const day = parseInt(linkText);
        return `${yr}-${String(mo+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      }

      return null;
    };

    document.querySelectorAll(".rbc-event-content").forEach(el => {
      const text = el.innerText?.trim();
      if (!text || !/^\d{1,2}:\d{2}/.test(text)) return;

      const date = getDateForCell(el);
      if (!date) return;

      // Confirm this date belongs to our target month
      const [dYr, dMo] = date.split("-").map(Number);
      if (dYr !== yr || dMo !== mo + 1) return;

      const m = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
      if (!m) return;
      const time = m[1];
      const rest = m[2].trim();
      const mm = rest.match(mapRx);
      const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
      if (title.length < 2) return;

      const key = `${date}|${time}|${title}`;
      if (seen.has(key)) return;
      seen.add(key);

      const url = el.closest("a[href]")?.href || null;
      results.push({ date, time, title, url });
    });

    return results;
  }, yr, mo, MAP_RX.source);

  console.log(`    ${domMatches.length} match(es) from DOM cells`);
  matches.push(...domMatches);

  // ── Pass 2: click "+N more" buttons (rbc-show-more) for overflow events ──
  const moreBtns = await page.evaluate((yr, mo) => {
    // rbc uses .rbc-show-more for overflow buttons
    const btns = Array.from(document.querySelectorAll(".rbc-show-more, [class*=show-more]"))
      .concat(Array.from(document.querySelectorAll("*"))
        .filter(el => el.children.length === 0 && /^\+\d+\s*(more)?$/i.test(el.textContent.trim())));

    return btns.map((btn, idx) => {
      // Find date from parent row structure
      const row = btn.closest(".rbc-month-row, .rbc-week-row, [class*=rbc-row]");
      if (!row) return null;
      const dateCells = Array.from(row.querySelectorAll(".rbc-date-cell, [class*=date-cell]"));

      // Use offsetLeft to determine column
      const rowWidth = row.offsetWidth;
      const colWidth = rowWidth / 7;
      const btnLeft = btn.offsetLeft || btn.getBoundingClientRect().left - row.getBoundingClientRect().left;
      const colIdx = Math.min(Math.round(btnLeft / colWidth), dateCells.length - 1);
      const dateCell = dateCells[colIdx] || dateCells[0];
      if (!dateCell) return null;

      const linkText = dateCell.querySelector("a, button")?.textContent?.trim();
      if (!linkText || !/^\d{1,2}$/.test(linkText)) return null;
      const day = parseInt(linkText);
      const date = `${yr}-${String(mo+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      return { date, idx };
    }).filter(Boolean);
  }, yr, mo);

  if (moreBtns.length > 0) {
    console.log(`    Clicking ${moreBtns.length} "+more" button(s)...`);
    for (const { date: dateStr } of moreBtns) {
      try {
        await page.evaluate((yr, mo) => {
          const btns = Array.from(document.querySelectorAll(".rbc-show-more, [class*=show-more]"))
            .concat(Array.from(document.querySelectorAll("*"))
              .filter(el => el.children.length === 0 && /^\+\d+\s*(more)?$/i.test(el.textContent.trim())));
          if (btns[0]) btns[0].click();
        }, yr, mo);

        await new Promise(r => setTimeout(r, 700));
        const popupMatches = await readOpenPopup(page, dateStr);

        for (const pm of popupMatches) {
          const key = `${pm.date}|${pm.time}|${pm.title}`;
          if (!matches.some(m => `${m.date}|${m.time}|${m.title}` === key)) {
            matches.push(pm);
          }
        }

        await page.keyboard.press("Escape");
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.log(`    +more error for ${dateStr}: ${e.message}`);
      }
    }
  }

  return matches;
}

// ── Main Pracc scraper ──
async function scrapePracc() {
  console.log("🌐 Launching browser...");
  const browser = await puppeteer.launch({
    headless: !CONFIG.DEBUG,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  try {
    // ── Login ──
    console.log("🔐 Logging into pracc.gg...");
    await page.goto("https://pracc.com/login", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("button", { timeout: 15000 });

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button"))
        .find(b => b.textContent.trim().toUpperCase().includes("LOGIN WITH EMAIL"));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1500));

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
    if (page.url().includes("login")) throw new Error("pracc.gg login failed — check credentials");
    console.log("✓ Logged into pracc.gg");

    // ── Matches page ──
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

      const monthMatches = await scrapeMonth(page, targetDate);
      allMatches.push(...monthMatches);
    }

    await browser.close();

    // Final dedup
    const seen = new Set();
    const deduped = allMatches.filter(m => {
      const k = `${m.date}|${m.time}|${m.title}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
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

  if (!CONFIG.PRACC_EMAIL || !CONFIG.PRACC_PASSWORD) throw new Error("PRACC_EMAIL and PRACC_PASSWORD must be set");
  if (!CONFIG.TRACKER_PASSWORD) throw new Error("TRACKER_PASSWORD must be set");

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

  const existing = await getExistingEvents(token);
  const today = new Date().toISOString().slice(0, 10);
  const oldPracc = existing.filter(e => e.cat === "Pracc" && e.date >= today);

  if (oldPracc.length > 0) {
    console.log(`🗑  Removing ${oldPracc.length} old Pracc events...`);
    for (const ev of oldPracc) await deleteEvent(token, ev.id);
  }

  let added = 0;
  console.log("➕ Syncing matches to tracker...\n");
  for (const m of praccMatches) {
    if (m.date < today) continue;
    const r = await postEvent(token, {
      title: m.title, date: m.date, time: m.time,
      cat: "Pracc", color: PRACC_COLOR, url: m.url || null,
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
