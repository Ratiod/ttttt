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
    'button[aria-label="Next month"]', 'button[aria-label="next month"]',
    '[data-testid="next-month"]', '.fc-next-button',
    'button:has(svg[data-icon="chevron-right"])',
  ];
  for (const sel of selectors) {
    try { await page.click(sel); return true; } catch (_) {}
  }
  return page.evaluate(() => {
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

// ── Scrape one month ──
// Approach: read all event elements directly from the DOM (covers visible events),
// then click only "+N more" buttons for overflow events (using the data-date of their
// parent cell so we always know the correct date).
async function scrapeMonth(page, targetDate) {
  const yr = targetDate.getFullYear();
  const mo = targetDate.getMonth();
  const matches = [];

  // ── Pass 1: read every event element directly from the calendar DOM ──
  const domMatches = await page.evaluate((yr, mo, MAP_RX_STR) => {
    const mapRx = new RegExp(MAP_RX_STR, "i");
    const results = [];
    const seen = new Set();

    // Collect all [data-date] cells for this month
    document.querySelectorAll("[data-date]").forEach(cell => {
      const date = cell.getAttribute("data-date");
      if (!date) return;
      const [cellYr, cellMo] = date.split("-").map(Number);
      if (cellYr !== yr || cellMo !== mo + 1) return;

      const links = Array.from(cell.querySelectorAll("a[href]")).map(a => ({
        text: a.innerText.trim(), href: a.href,
      }));

      // Walk every leaf text node inside the cell
      cell.querySelectorAll("*").forEach(el => {
        // Skip "+N more" buttons themselves
        if (/^\+\d+\s*more$/i.test(el.textContent.trim())) return;
        const line = el.innerText?.trim();
        if (!line || !/^\d{1,2}:\d{2}/.test(line)) return;
        // Only leaf-ish nodes (no children with time content)
        const childHasTime = Array.from(el.children).some(c => /\d{1,2}:\d{2}/.test(c.innerText || ""));
        if (childHasTime) return;

        const m = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(.+)/);
        if (!m) return;
        const time = m[1];
        const rest = m[2].trim();
        if (/^\+\d+/.test(rest)) return;
        const mm = rest.match(mapRx);
        const title = mm ? `${mm[1].trim()} — ${mm[2]}` : rest;
        if (title.length < 2) return;
        const key = `${date}|${time}|${title}`;
        if (seen.has(key)) return;
        seen.add(key);
        const link = links.find(l => l.text.includes(time) || l.text.includes(rest.slice(0, 12)));
        results.push({ date, time, title, url: link?.href || null });
      });
    });

    return results;
  }, yr, mo, MAP_RX.source);

  console.log(`    ${domMatches.length} match(es) from DOM cells`);
  matches.push(...domMatches);

  // ── Pass 2: click "+N more" buttons for overflow events not rendered in the cell ──
  // Get list of {element, dateStr} pairs for all "+more" buttons
  const moreBtns = await page.evaluate((yr, mo) => {
    return Array.from(document.querySelectorAll("*"))
      .filter(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()))
      .map(el => {
        const cell = el.closest("[data-date]");
        const date = cell?.getAttribute("data-date") || null;
        if (!date) return null;
        const [cellYr, cellMo] = date.split("-").map(Number);
        if (cellYr !== yr || cellMo !== mo + 1) return null;
        return date;
      })
      .filter(Boolean);
  }, yr, mo);

  if (moreBtns.length > 0) {
    console.log(`    Clicking ${moreBtns.length} "+more" button(s)...`);
  }

  for (const dateStr of moreBtns) {
    try {
      // Click the "+more" button for this specific date
      await page.evaluate((dateStr) => {
        const cell = document.querySelector(`[data-date="${dateStr}"]`);
        if (!cell) return;
        const btn = Array.from(cell.querySelectorAll("*"))
          .find(el => el.children.length === 0 && /^\+\d+\s*more$/i.test(el.textContent.trim()));
        if (btn) btn.click();
      }, dateStr);

      await new Promise(r => setTimeout(r, 700));
      const popupMatches = await readOpenPopup(page, dateStr);

      // Only add matches that aren't already captured from DOM
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
    // Always dump DOM and screenshot so we can debug structure
    await page.screenshot({ path: "pracc-matches.png", fullPage: true });
    const domDump = await page.evaluate(() => document.body.innerHTML);
    require("fs").writeFileSync("pracc-dom.html", domDump);
    console.log("  📸 Screenshot + DOM saved (pracc-matches.png, pracc-dom.html)");
    
    // Log ALL elements that contain a time pattern so we can see what's on screen
    const timeEls = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll("*").forEach(el => {
        if (el.children.length > 0) return;
        const t = el.textContent?.trim();
        if (t && /^\d{1,2}:\d{2}/.test(t)) {
          results.push({
            tag: el.tagName,
            classes: el.className,
            dataDate: el.getAttribute("data-date"),
            parentDataDate: el.closest("[data-date]")?.getAttribute("data-date"),
            text: t.slice(0, 80),
          });
        }
      });
      return results.slice(0, 30);
    });
    console.log("  Time elements found on page:");
    timeEls.forEach(e => console.log("   ", JSON.stringify(e)));

    // Deep debug: for first rbc-event-content, log full ancestor chain with classes + text
    const ancestorInfo = await page.evaluate(() => {
      const el = document.querySelector(".rbc-event-content");
      if (!el) return "no rbc-event-content found";
      const chain = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const dateCells = Array.from(cur.querySelectorAll(".rbc-date-cell")).map(d => ({
          classes: d.className,
          text: d.innerText?.trim().slice(0,30),
          ariaLabel: d.getAttribute("aria-label"),
          dataDate: d.getAttribute("data-date"),
          linkText: d.querySelector("a,button")?.textContent?.trim(),
        }));
        chain.push({
          tag: cur.tagName,
          classes: cur.className?.slice(0,80),
          dataDate: cur.getAttribute("data-date"),
          childDateCells: dateCells.length,
          dateCellSamples: dateCells.slice(0,3),
        });
        if (dateCells.length > 0) break;
        cur = cur.parentElement;
      }
      return chain;
    });
    console.log("  Ancestor chain of first event:");
    console.log(JSON.stringify(ancestorInfo, null, 2));

    // Dump the full ancestor chain for the first rbc-event-content so we can see the structure
    const ancestorDump = await page.evaluate(() => {
      const el = document.querySelector(".rbc-event-content");
      if (!el) return "no rbc-event-content found";
      let node = el;
      const chain = [];
      for (let i = 0; i < 12; i++) {
        if (!node) break;
        const dateCells = Array.from(node.querySelectorAll(".rbc-date-cell")).map(dc => ({
          classes: dc.className,
          text: dc.innerText?.trim(),
          dataDate: dc.getAttribute("data-date"),
          ariaLabel: dc.getAttribute("aria-label"),
          childA: dc.querySelector("a,button")?.textContent?.trim(),
        }));
        chain.push({
          tag: node.tagName,
          classes: node.className?.toString().slice(0, 80),
          dataDate: node.getAttribute?.("data-date"),
          ariaLabel: node.getAttribute?.("aria-label"),
          offsetLeft: node.offsetLeft,
          offsetWidth: node.offsetWidth,
          dateCellsFound: dateCells.length,
          dateCells,
        });
        node = node.parentElement;
      }
      return chain;
    });
    console.log("\n  Ancestor chain of first event:");
    (Array.isArray(ancestorDump) ? ancestorDump : []).forEach((a, i) =>
      console.log(`    [${i}]`, JSON.stringify(a))
    );

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
