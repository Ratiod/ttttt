/**
 * sync-pracc.js
 * Scrapes pracc.gg (React Big Calendar) and syncs matches to your Racker tracker.
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
  MONTHS_AHEAD:     parseInt(process.env.MONTHS_AHEAD || "0", 10),
  DEBUG:            process.env.DEBUG === "true",
};

const PRACC_COLOR = "#ff7043";
const MAPS = ["Split","Haven","Bind","Breeze","Fracture","Icebox","Lotus","Abyss","Sunset","Ascent","Pearl","Corrode"];
const MAP_RX = new RegExp(`^(.+?)\\s*[-–]\\s*(${MAPS.join("|")})$`, "i");

// ── Tracker API ──

// Reads the response as text first, then tries to parse JSON.
// If parsing fails or the status isn't ok, throws an error that includes
// the status code and raw body so failures are diagnosable instead of
// surfacing as a bare "Unexpected end of JSON input".
async function safeJson(res, label) {
  const raw = await res.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) {
      throw new Error(`${label}: non-JSON response (status ${res.status}): ${raw.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} — ${raw ? raw.slice(0, 300) : "(empty body)"}`);
  }
  if (data === null) {
    throw new Error(`${label}: empty response body (status ${res.status})`);
  }
  return data;
}

async function getTrackerToken() {
  const res = await fetch(`${CONFIG.TRACKER_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: CONFIG.TRACKER_USERNAME, password: CONFIG.TRACKER_PASSWORD }),
  });
  const data = await safeJson(res, "Tracker login failed");
  if (!data.token) throw new Error(`Tracker login failed: ${JSON.stringify(data)}`);
  console.log("✓ Logged into tracker");
  return data.token;
}

async function getExistingEvents(token) {
  const res = await fetch(`${CONFIG.TRACKER_URL}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return safeJson(res, "getExistingEvents failed");
}

async function postEvent(token, event) {
  const res = await fetch(`${CONFIG.TRACKER_URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
  return safeJson(res, `postEvent failed (${event.title})`);
}

async function deleteEvent(token, id) {
  const res = await fetch(`${CONFIG.TRACKER_URL}/api/events/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    console.warn(`  ⚠️  deleteEvent(${id}) failed: HTTP ${res.status} ${raw.slice(0, 200)}`);
  }
}

// ── Next month button ──
async function clickNextMonth(page) {
  // React Big Calendar toolbar: "Back" | "Today" | "Next"
  const clicked = await page.evaluate(() => {
    const toolbar = document.querySelector(".rbc-toolbar");
    if (toolbar) {
      const btns = Array.from(toolbar.querySelectorAll("button"));
      // rbc toolbar order is typically: [Back] [Today] [Next]
      // Try by text first
      let nextBtn = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === "next" || t === ">" || t === "›" || t === "→";
      });
      // Fallback: last button in the first button group
      if (!nextBtn) {
        const groups = toolbar.querySelectorAll(".rbc-btn-group");
        const firstGroup = groups[0];
        if (firstGroup) {
          const groupBtns = Array.from(firstGroup.querySelectorAll("button"));
          nextBtn = groupBtns[groupBtns.length - 1];
        }
      }
      if (!nextBtn) nextBtn = btns[btns.length - 1];
      if (nextBtn) { nextBtn.click(); return true; }
    }
    return false;
  });
  if (clicked) return true;
  // Fallbacks
  const selectors = [
    'button[aria-label="Next month"]', 'button[aria-label="next month"]',
    '[data-testid="next-month"]', '.fc-next-button',
  ];
  for (const sel of selectors) {
    try { await page.click(sel); return true; } catch (_) {}
  }
  return false;
}

// ── Core: scrape all events for a month using rbc DOM structure ──
// Structure (from debug):
//   .rbc-month-row
//     .rbc-row-content
//       .rbc-row  (date header row — contains .rbc-date-cell × 7)
//       .rbc-row  (event row — contains .rbc-row-segment × N)
//         .rbc-row-segment  (offsetLeft tells us which column)
//           .rbc-event
//             .rbc-event-content  (text = "HH:MM - Title - Map")
async function scrapeMonth(page, targetDate) {
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth(); // 0-indexed

  return page.evaluate((yr, mo, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];
    const seen = new Set();

    // Each .rbc-month-row covers one week (a row of 7 days)
    document.querySelectorAll(".rbc-month-row").forEach(monthRow => {
      const rowContent = monthRow.querySelector(".rbc-row-content");
      if (!rowContent) return;

      // The first .rbc-row inside rbc-row-content is the date header row
      const rows = Array.from(rowContent.querySelectorAll(":scope > .rbc-row"));
      const dateRow = rows[0];
      if (!dateRow) return;

      // Get the 7 date cells and their day numbers
      const dateCells = Array.from(dateRow.querySelectorAll(".rbc-date-cell"));
      if (dateCells.length === 0) return;

      const rowWidth = rowContent.offsetWidth;
      const colWidth = rowWidth / 7;

      // Build column-index → dateStr map for this week row
      // We know the current month/year — off-range cells (prev/next month) get skipped
      const colToDate = {};
      dateCells.forEach((cell, idx) => {
        const dayNum = parseInt(cell.textContent.trim());
        if (isNaN(dayNum)) return;

        // Determine if this cell is in the current month or off-range
        const isOffRange = cell.classList.contains("rbc-off-range");
        if (isOffRange) return; // skip days from adjacent months

        colToDate[idx] = `${yr}-${String(mo + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      });

      // Now find all event segments in the remaining rows of this week
      rows.slice(1).forEach(evRow => {
        const allSegments = Array.from(evRow.querySelectorAll(":scope > .rbc-row-segment"));
        allSegments.forEach(segment => {
          const eventContent = segment.querySelector(".rbc-event-content");
          if (!eventContent) return;

          const text = eventContent.innerText?.trim();
          if (!text || !/^\d{1,2}:\d{2}/.test(text)) return;

          // Work out the column from the segment's real on-screen position.
          // (rbc segments use flex-basis, not left%, and empty gaps are
          // collapsed into one spacer segment, so index-in-parent is wrong.)
          const segRect = segment.getBoundingClientRect();
          const rowRect = rowContent.getBoundingClientRect();
          let colIdx = Math.floor((segRect.left - rowRect.left + colWidth * 0.5) / colWidth);
          colIdx = Math.max(0, Math.min(colIdx, 6));

          // Exact column only. If it's an off-range day (prev/next month),
          // skip it rather than guessing a neighbouring date.
          const dateStr = colToDate[colIdx];
          if (!dateStr) return;

          const m = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
          if (!m) return;
          const time = m[1];
          const rest = m[2].trim();
          const mm = rest.match(mapRx);
          const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
          if (title.length < 2) return;

          const key = `${dateStr}|${time}|${title}`;
          if (seen.has(key)) return;
          seen.add(key);

          const url = segment.querySelector("a[href]")?.href || null;
          results.push({ date: dateStr, time, title, url });
        });
      });
    });

    return results;
  }, yr, mo, MAP_RX.source);
}

// ── Read open popup (for +more overflow) ──
async function readOpenPopup(page, dateStr) {
  return page.evaluate((dateStr, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];
    const candidates = Array.from(document.querySelectorAll("*")).filter(el => {
      if (!el.innerText) return false;
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const isOverlay = s.position === "absolute" || s.position === "fixed" || parseInt(s.zIndex) > 5;
      return isOverlay && /\d{1,2}:\d{2}/.test(el.innerText) && el.offsetWidth > 80;
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

// ── Main scraper ──
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

    // "Show Past Matches" is a per-session checkbox that defaults to OFF
    // for a fresh headless login, which hides most of the current month
    // once "today" has passed. Turn it on so past + upcoming both render.
    const pastToggled = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("label, span, div"));
      const target = labels.find(el => el.textContent.trim() === "Show Past Matches");
      if (!target) return false;
      // The checkbox is usually a sibling/child <input type="checkbox">
      const container = target.closest("label") || target.parentElement;
      const checkbox = container?.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) { checkbox.click(); return true; }
      if (checkbox && checkbox.checked) return "already-on";
      // Fallback: some UI kits render a clickable div instead of a real checkbox
      target.click();
      return "clicked-label";
    });
    console.log(`  🕓 Show Past Matches: ${pastToggled}`);
    await new Promise(r => setTimeout(r, 1500));

    if (CONFIG.DEBUG) await page.screenshot({ path: "pracc-matches.png", fullPage: true });

    const allMatches = [];
    const today = new Date();


    for (let mo = 0; mo <= CONFIG.MONTHS_AHEAD; mo++) {
      const targetDate = new Date(today.getFullYear(), today.getMonth() + mo, 1);
      const monthLabel = targetDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      console.log(`\n  📆 Scraping ${monthLabel}...`);

      if (mo > 0) {
        const moved = await clickNextMonth(page);
        if (!moved) {
          console.warn("  ⚠️  Could not find next month button — stopping here");
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Pass 1: direct DOM read
      const monthMatches = await scrapeMonth(page, targetDate);
      console.log(`    ${monthMatches.length} match(es) from calendar`);
      monthMatches.forEach(m => console.log(`    ✓ ${m.date}  ${m.time}  ${m.title}`));
      allMatches.push(...monthMatches);

      // Pass 2: +more overflow buttons
      const moreBtns = await page.evaluate((yr, mo) => {
        const results = [];
        document.querySelectorAll(".rbc-show-more, [class*='show-more']").forEach(btn => {
          const row = btn.closest(".rbc-month-row");
          if (!row) return;
          const rowContent = row.querySelector(".rbc-row-content");
          if (!rowContent) return;
          const dateRow = rowContent.querySelector(":scope > .rbc-row");
          if (!dateRow) return;
          const dateCells = Array.from(dateRow.querySelectorAll(".rbc-date-cell"))
            .filter(c => !c.classList.contains("rbc-off-range"));
          if (!dateCells.length) return;
          const rowWidth = rowContent.offsetWidth;
          const colWidth = rowWidth / 7;
          const btnLeft = btn.getBoundingClientRect().left - rowContent.getBoundingClientRect().left;
          const colIdx = Math.max(0, Math.min(Math.floor((btnLeft + colWidth * 0.5) / colWidth), 6));
          // Find nearest non-off-range cell
          const allCells = Array.from(dateRow.querySelectorAll(".rbc-date-cell"));
          const cell = allCells[colIdx];
          if (!cell || cell.classList.contains("rbc-off-range")) return;
          const dayNum = parseInt(cell.textContent.trim());
          if (isNaN(dayNum)) return;
          results.push(`${yr}-${String(mo + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`);
        });
        return results;
      }, targetDate.getFullYear(), targetDate.getMonth());

      if (moreBtns.length > 0) {
        console.log(`    Clicking ${moreBtns.length} "+more" button(s)...`);
        const existingKeys = new Set(allMatches.map(m => `${m.date}|${m.time}|${m.title}`));

        for (const dateStr of moreBtns) {
          try {
            await page.evaluate((dateStr, yr, mo) => {
              document.querySelectorAll(".rbc-show-more, [class*='show-more']").forEach(btn => {
                const row = btn.closest(".rbc-month-row");
                if (!row) return;
                const rowContent = row.querySelector(".rbc-row-content");
                const dateRow = rowContent?.querySelector(":scope > .rbc-row");
                const cells = Array.from(dateRow?.querySelectorAll(".rbc-date-cell") || []);
                const rowWidth = rowContent?.offsetWidth || 1;
                const colIdx = Math.max(0, Math.min(Math.floor(((btn.getBoundingClientRect().left - rowContent.getBoundingClientRect().left) + (rowWidth / 14)) / (rowWidth / 7)), 6));
                const cell = cells[colIdx];
                const dayNum = parseInt(cell?.textContent?.trim());
                const d = `${yr}-${String(mo + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                if (d === dateStr) btn.click();
              });
            }, dateStr, targetDate.getFullYear(), targetDate.getMonth());

            await new Promise(r => setTimeout(r, 700));
            const popupMatches = await readOpenPopup(page, dateStr);
            for (const pm of popupMatches) {
              const key = `${pm.date}|${pm.time}|${pm.title}`;
              if (!existingKeys.has(key)) {
                existingKeys.add(key);
                allMatches.push(pm);
                console.log(`    ✓ ${pm.date}  ${pm.time}  ${pm.title}  (via +more)`);
              }
            }
            await page.keyboard.press("Escape");
            await new Promise(r => setTimeout(r, 400));
          } catch (e) {
            console.log(`    +more error: ${e.message}`);
          }
        }
      }
    }

    await browser.close();

    // Final dedup
    const seen = new Set();
    return allMatches.filter(m => {
      const k = `${m.date}|${m.time}|${m.title}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });

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
  const monthStart = today.slice(0, 8) + "01"; // first day of current month
  const oldPracc = existing.filter(e => e.cat === "Pracc" && e.date >= monthStart);

  if (oldPracc.length > 0) {
    console.log(`🗑  Removing ${oldPracc.length} old Pracc events...`);
    for (const ev of oldPracc) await deleteEvent(token, ev.id);
  }

  let added = 0;
  console.log("➕ Syncing matches to tracker...\n");
  for (const m of praccMatches) {
    if (m.date < monthStart) continue;
    try {
      const r = await postEvent(token, {
        title: m.title, date: m.date, time: m.time,
        cat: "Pracc", color: PRACC_COLOR, url: m.url || null,
      });
      if (r.id) {
        console.log(`  ✓ ${m.date}  ${m.time}  ${m.title}`);
        added++;
      } else {
        console.warn(`  ⚠️  No id returned for ${m.title}: ${JSON.stringify(r)}`);
      }
    } catch (e) {
      console.warn(`  ⚠️  Failed to post "${m.title}": ${e.message}`);
    }
  }

  console.log(`\n🎉 Done! ${added} matches synced to your tracker calendar.\n`);
}

sync().catch(err => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
