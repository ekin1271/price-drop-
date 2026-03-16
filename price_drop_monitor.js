const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID = process.env.GROUP_CHAT_ID;
const STATE_FILE = 'drop_state.json';
const HOTELS_FILE = 'hotels.json';
const CONCURRENCY = 8;
const DROP_THRESHOLD = 0.30; // %50 düşüş

const PENINSULA_PATTERNS = [
  '103810219',    // Antalya
  '103810221461', // Bodrum
  '103810221462', // Bodrum
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadHotels() {
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}

function generateDates() {
  const dates = [];
  const now = new Date();
  const firstDate = new Date(now);
  firstDate.setDate(firstDate.getDate() + 5);

  if (firstDate.getMonth() === 2) {
    firstDate.setMonth(3);
    firstDate.setDate(15);
  }

  for (let m = 0; m < 4; m++) {
    const d = m === 0
      ? new Date(firstDate)
      : new Date(firstDate.getFullYear(), firstDate.getMonth() + m, 15);

    const fmt = n => String(n).padStart(2, '0');
    const checkIn  = `${fmt(d.getDate())}.${fmt(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d);
    out.setDate(out.getDate() + 7);
    const checkOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn, checkOut });
  }
  return dates;
}

function buildUrl(hotel, checkIn, checkOut) {
  const idPrice = hotel.id_price || '121110211811';
  return `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=${idPrice}&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotel.id}&ins=0-40000-EUR&flt=100411293179&p=${hotel.p}`;
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0, 120)); return; }
  const targets = [TELEGRAM_CHAT_ID];
  if (TELEGRAM_GROUP_ID) targets.push(TELEGRAM_GROUP_ID);

  for (const chatId of targets) {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ─── Scrape ──────────────────────────────────────────────────────────────────
async function scrapePage(browser, url, checkIn, hotelId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(2000);

  const peninsulaPatterns = PENINSULA_PATTERNS;

  const offers = await page.evaluate((peninsulaPatterns, targetDate, expectedHotelId) => {
    const results = [];
    const blocks = document.querySelectorAll('div.b-pr');

    for (const block of blocks) {
      // data-hid kontrolü
      if (expectedHotelId) {
        const nameDiv = block.querySelector('div.name[data-hid]');
        if (nameDiv) {
          const dataHid = nameDiv.getAttribute('data-hid');
          if (dataHid && dataHid !== expectedHotelId) continue;
        }
      }

      let hotelName = '';
      const hotelLink = block.querySelector('a[href*="action=shw"]');
      if (hotelLink) hotelName = hotelLink.textContent.trim();

      const allRows = block.querySelectorAll('tr');

      for (const tr of allRows) {
        const allLis = tr.querySelectorAll('li.s8.i_t1');
        if (allLis.length === 0) continue;

        let chosenLi = allLis[0];
        if (targetDate) {
          for (const li of allLis) {
            if ((li.getAttribute('urr') || '').includes(targetDate)) {
              chosenLi = li;
              break;
            }
          }
        }

        const urr = chosenLi.getAttribute('urr') || '';
        const isPeninsula = peninsulaPatterns.some(p => urr.includes(p));
        if (!isPeninsula) continue;

        const priceLink = tr.querySelector('td.c_pe a[href*="x="]');
        if (!priceLink) continue;
        const m = (priceLink.getAttribute('href') || '').match(/[?&]x=(\d+)/);
        if (!m) continue;
        const price = parseInt(m[1], 10);
        if (!price) continue;

        const roomTd = tr.querySelector('td.c_ns');
        const roomType = roomTd ? roomTd.textContent.trim().split('\n')[0].trim() : 'UNKNOWN';

        results.push({ hotelName, roomType, price });
      }
    }
    return results;
  }, peninsulaPatterns, checkIn, hotelId);

  await page.close();
  return offers;
}

async function scrapeWithDateShift(browser, url, checkIn, hotelId) {
  let offers = await scrapePage(browser, url, checkIn, hotelId);
  if (offers.length > 0) return { offers, usedCheckIn: checkIn };

  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const fmt = n => String(n).padStart(2, '0');
  const newCheckIn  = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;
  const out = new Date(date);
  out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
  const newUrl = url
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/,   `d2=${newCheckOut}`);

  offers = await scrapePage(browser, newUrl, newCheckIn, hotelId);
  return { offers, usedCheckIn: newCheckIn };
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Concurrency ─────────────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    await Promise.all(batch.map(t => t()));
    if (i + concurrency < tasks.length) await sleep(500);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fiyat düşüş taraması başlıyor...');
  const hotels = loadHotels();
  const dates  = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState = loadState();
  const newState  = { ...prevState };
  const alerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const tasks = [];
    for (const { checkIn, checkOut } of dates) {
      for (const hotel of hotels) {
        tasks.push({ url: buildUrl(hotel, checkIn, checkOut), checkIn, hotelId: hotel.id });
      }
    }
    console.log(`Toplam istek: ${tasks.length}`);

    let done = 0, errors = 0;

    await runConcurrent(tasks.map(task => async () => {
      try {
        const { offers, usedCheckIn } = await scrapeWithDateShift(browser, task.url, task.checkIn, task.hotelId);

        for (const o of offers) {
          const key = `${usedCheckIn}__${o.hotelName}__${o.roomType}`;
          const prevPrice = prevState[key];
          const newPrice  = o.price;

          // State'e kaydet
          newState[key] = newPrice;

          // Önceki fiyat varsa ve %50'den fazla düştüyse alarm
          if (prevPrice && prevPrice > 0) {
            const drop = (prevPrice - newPrice) / prevPrice;
            if (drop >= DROP_THRESHOLD) {
              alerts.push({
                checkIn: usedCheckIn,
                hotel: o.hotelName,
                room: o.roomType,
                prevPrice,
                newPrice,
                dropPct: Math.round(drop * 100),
              });
              console.log(`  ⚠️ DÜŞÜŞ: ${o.hotelName} | ${o.roomType} | ${prevPrice}→${newPrice} EUR (-%${Math.round(drop*100)})`);
            }
          }
        }
      } catch (e) {
        errors++;
        console.log(`  [HATA] ${task.hotelId} ${task.checkIn}: ${e.message}`);
      }
      done++;
      if (done % 50 === 0 || done === tasks.length) {
        console.log(`  ${done}/${tasks.length} tamamlandı (${errors} hata)`);
      }
    }), CONCURRENCY);

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (alerts.length > 0) {
    console.log(`${alerts.length} fiyat düşüşü tespit edildi. Bildirim gönderiliyor...`);

    // Gruplama
    const groups = {};
    for (const a of alerts) {
      const key = `${a.hotel}__${a.room}`;
      if (!groups[key]) groups[key] = { hotel: a.hotel, room: a.room, entries: [] };
      groups[key].entries.push(a);
    }

    const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
    let current = '🚨 <b>Fiyat Düşüş Alarmı</b>\n\n';

    for (const g of Object.values(groups)) {
      let block = `🏨 <b>${g.hotel}</b>\n🛏 ${g.room}\n`;
      for (const a of g.entries) {
        block += `  📅 ${a.checkIn}\n`;
        block += `     💰 Önceki: ${a.prevPrice} EUR\n`;
        block += `     ⬇️ Yeni: ${a.newPrice} EUR (-%${a.dropPct})\n`;
      }
      block += `─────────────────\n`;

      if ((current + block).length > 3500) {
        await sendTelegram(current);
        current = '🚨 <b>Fiyat Düşüş Alarmı (devam)</b>\n\n' + block;
      } else {
        current += block;
      }
    }
    await sendTelegram(current + time);
  } else {
    console.log('Anormal fiyat düşüşü yok.');
  }
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  await sendTelegram(`❌ <b>Fiyat Düşüş Monitor Hatası</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
