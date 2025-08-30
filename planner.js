// public/scripts/planner.js
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let currentUser = null;
let tripPayload = null;
let pois = { hotels: [], attractions: [], restaurants: [] };
let center = null;             // {lat, lon} of destination (or hotel)
let detailsCache = new Map();  // xid -> details
let lastItinerary = null;      // structured itinerary used for saving/PDF

// ====== CONFIG ======
const API_KEY = "5ae2e3f221c38a28845f05b6900d2414ff5ecf8ba93aa37c99b9a6bd"; // <-- REPLACE with your OpenTripMap API key
const RADIUS = 5000; // meters
const BRAND = {
  name: "mini-wanderlog",
  color: [8, 132, 123], // teal-ish RGB for headers in PDF
  accent: [235, 248, 247]
};
const LOGO_URL = "logo.png"; // optional; place in public/ if you want it in PDF
// =====================

// UI refs (assume planner.html includes these ids)
const tripSummary = document.getElementById('tripSummary');
const hotelsList = document.getElementById('hotelsList');
const attractionsList = document.getElementById('attractionsList');
const restaurantsList = document.getElementById('restaurantsList');
const generatedItinerary = document.getElementById('generatedItinerary');
const autoGenerateBtn = document.getElementById('autoGenerateBtn');
const saveBtn = document.getElementById('saveBtn');
const exportPdfBtn = document.getElementById('exportPdfBtn');
const backBtn = document.getElementById('backBtn');

onAuthStateChanged(auth, user => { currentUser = user; loadSavedIfAny(); });

// UI events
backBtn?.addEventListener('click', () => history.back());
saveBtn?.addEventListener('click', saveItinerary);
exportPdfBtn?.addEventListener('click', exportPDF);
autoGenerateBtn?.addEventListener('click', () => planAndRender());

/* ---------------- Init: load payload or a loadedItinerary from dashboard ---------------- */
function loadFromSession() {
  const loadedIt = sessionStorage.getItem('loadedItinerary');
  const p = sessionStorage.getItem('tripPayload');

  if (loadedIt) {
    const obj = JSON.parse(loadedIt);

    if (obj.itinerary) {
      // ✅ Structured itinerary (from saved trips)
      lastItinerary = obj.itinerary;
      tripPayload = {
        destination: obj.destination || lastItinerary.destination || lastItinerary.title || '',
        startDate: obj.startDate || lastItinerary.startDate || '',
        endDate: obj.endDate || lastItinerary.endDate || '',
        days: obj.days || (lastItinerary.days ? lastItinerary.days.length : 1),
        budget: obj.budget || '',
        companion: obj.companion || ''
      };
      renderTripSummary();

      const toDetail = [];
      if (lastItinerary.hotel) toDetail.push(lastItinerary.hotel);
      lastItinerary.days.forEach(d => {
        ['morning','afternoon','evening'].forEach(s => { if (d[s]) toDetail.push(d[s]); });
      });

      fetchDetailsBatch(toDetail).then(() => {
        generatedItinerary.innerHTML = renderItineraryHTML(lastItinerary);
      });
      return;
    } 
    else if (obj.content && typeof obj.content === 'string') {
      // ✅ Old format (raw text only)
      tripPayload = {
        destination: obj.destination || '',
        startDate: obj.startDate || '',
        endDate: obj.endDate || '',
        days: obj.days || 1,
        budget: obj.budget || '',
        companion: obj.companion || ''
      };
      renderTripSummary();
      generatedItinerary.innerText = obj.content;
      return;
    }
  }

  if (p) {
    tripPayload = JSON.parse(p);
    renderTripSummary();

    // ✅ AI structured itinerary
    if (tripPayload.aiItineraryStructured) {
      const s = tripPayload.aiItineraryStructured;
      const daysCount = Math.max(1, parseInt(tripPayload.days || (s.days ? s.days.length : 1), 10));

      const newDays = (s.days || []).slice(0, daysCount).map((d, idx) => {
        const mk = (text, slot) => {
          if (!text || !String(text).trim()) return null;
          const xid = `ai_${idx+1}_${slot}`;
          const name = String(text).trim();
          detailsCache.set(xid, { name, address: "", desc: "" });
          return { xid, name };
        };
        return {
          day: idx+1,
          morning: mk(d.morning, "morning"),
          afternoon: mk(d.afternoon, "afternoon"),
          evening: mk(d.evening, "evening")
        };
      });

      lastItinerary = {
        title: s.title || `${tripPayload.destination} Trip`,
        destination: s.destination || tripPayload.destination,
        startDate: s.startDate || tripPayload.startDate || '',
        endDate: s.endDate || tripPayload.endDate || '',
        days: newDays,
        hotel: null
      };

      generatedItinerary.innerHTML = renderItineraryHTML(lastItinerary);
      return;
    }

    // ✅ AI raw text fallback
    if (tripPayload.aiItinerary) {
      const lines = tripPayload.aiItinerary
        .split("\n")
        .map(l => l.trim())
        .filter(l => l);

      let html = `
        <div class="day-block" style="background:#f9fbfb; padding:10px; border-radius:8px;">
          <h3>${tripPayload.destination} Trip Itinerary</h3>
          <div>${tripPayload.startDate || ''} → ${tripPayload.endDate || ''} • ${tripPayload.days} day(s)</div>
      `;

      let currentDay = "";
      lines.forEach(line => {
        if (/^Day\s*\d+/i.test(line)) {
          if (currentDay) html += `</div>`; 
          html += `<div class="day-block"><h4>${line}</h4>`;
          currentDay = line;
        } else {
          html += `<div class="poi-note">${line}</div>`;
        }
      });
      if (currentDay) html += `</div></div>`;

      generatedItinerary.innerHTML = html;
      return;
    }

    // ✅ Fallback to OpenTripMap
    geocodeAndFetchPOIs();
    return;
  }

  alert("No trip data found. Go back to dashboard.");
}



/* ---------------- Render trip summary ---------------- */
function renderTripSummary() {
  tripSummary.innerHTML = `
    <div><strong style="font-size:18px">${tripPayload.destination || ''}</strong> 
      <span class="badge">${tripPayload.companion || "No companion"}</span></div>
    <div>${tripPayload.startDate || ''} → ${tripPayload.endDate || ''} • ${tripPayload.days || 1} day(s) • 
      Budget: ${tripPayload.budget || "N/A"}</div>
  `;
}

/* ---------------- OpenTripMap Integration ---------------- */

async function geocodeAndFetchPOIs() {
  try {
    // 1) Geocode destination (OpenTripMap geoname)
    const geoResp = await fetch(
      `https://api.opentripmap.com/0.1/en/places/geoname?name=${encodeURIComponent(tripPayload.destination)}&apikey=${API_KEY}`
    );
    const geo = await geoResp.json();
    if (!geo || !geo.lat) throw new Error("Destination not found (geocoding failed)");
    center = { lat: geo.lat, lon: geo.lon };

    if (window.addMarkers) {
      window.addMarkers([{ name: tripPayload.destination, lat: center.lat, lon: center.lon }]);
    }

    // 2) Fetch POIs by kinds
    pois.attractions = await fetchPlaces(center.lat, center.lon, "interesting_places");
    pois.restaurants = await fetchPlaces(center.lat, center.lon, "restaurants");
    pois.hotels = await fetchPlaces(center.lat, center.lon, "other_hotels");

    // 3) annotate distance and sort
    for (const type of ["attractions","restaurants","hotels"]) {
      for (const p of pois[type]) p.dist = haversine(center.lat, center.lon, p.lat, p.lon);
      pois[type].sort((a,b) => (a.dist||0) - (b.dist||0));
    }

    renderPOILists();
  } catch (err) {
    console.error(err);
    hotelsList.innerText = attractionsList.innerText = restaurantsList.innerText = "Error fetching places: " + err.message;
  }
}

async function fetchPlaces(lat, lon, kind) {
  // safe wrapper - OpenTripMap returns .features array on success
  const url = `https://api.opentripmap.com/0.1/en/places/radius?radius=${RADIUS}&lon=${lon}&lat=${lat}&kinds=${kind}&limit=30&apikey=${API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data || !data.features) {
    console.warn("OpenTripMap returned no features for kind:", kind, data);
    return [];
  }
  return data.features.map(f => ({
    xid: f.id,
    name: f.properties.name || "Unnamed",
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    kinds: f.properties.kinds || "",
    rate: f.properties.rate || 0
  }));
}

function renderPOILists() {
  function render(container, list, type) {
    container.innerHTML = "";
    if (!list.length) {
      container.innerText = "No results";
      return;
    }
    list.slice(0,20).forEach(item => {
      const dist = item.dist ? ` • ${(item.dist/1000).toFixed(1)} km` : "";
      const node = document.createElement('div');
      node.innerHTML = `<label>
        <input type="checkbox" data-xid="${item.xid}" data-type="${type}" />
        <b>${item.name}</b> <span class="muted">${dist}</span>
        <div class="poi-note">${(item.kinds||'').split(',').slice(0,2).join(', ')}</div>
      </label>`;
      container.appendChild(node);
    });
  }
  render(hotelsList, pois.hotels, "hotel");
  render(attractionsList, pois.attractions, "attraction");
  render(restaurantsList, pois.restaurants, "restaurant");
}

/* ---------------- Smart scheduler ----------------
 * picks nearest attractions and restaurants for each day
 -------------------------------------------------- */

function getSelected() {
  const sel = { hotels: [], attractions: [], restaurants: [] };
  document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (!cb.checked) return;
    const type = cb.dataset.type + 's';
    const xid = cb.dataset.xid;
    const item = pois[type].find(x => String(x.xid) === String(xid));
    if (item) sel[type].push(item);
  });
  return sel;
}

// nearest returning { item, idx, dist } or null
function nearest(from, pool, used) {
  if (!from || !pool || !pool.length) return null;
  let best = null, bestD = Infinity, idx = -1;
  for (let i=0;i<pool.length;i++){
    if (used.has(pool[i].xid)) continue;
    const d = haversine(from.lat, from.lon, pool[i].lat, pool[i].lon);
    if (d < bestD) { best = pool[i]; bestD = d; idx = i; }
  }
  return best ? { item: best, idx, dist: bestD } : null;
}

async function planAndRender() {
  const sel = getSelected();
  const days = Math.max(1, parseInt(tripPayload.days || '3', 10));

  const hotel = sel.hotels[0] || pois.hotels[0] || null;
  const dayStartPoint = hotel ? { lat: hotel.lat, lon: hotel.lon } : center;

  const attrPool = sel.attractions.length ? sel.attractions.slice() : pois.attractions.slice(0, days * 4);
  const restPool = sel.restaurants.length ? sel.restaurants.slice() : pois.restaurants.slice(0, Math.max(days, 8));

  const used = new Set();
  const dayPlans = [];

  for (let d = 0; d < days; d++) {
    const plan = { day: d+1, morning: null, afternoon: null, evening: null };
    let origin = dayStartPoint;

    // morning
    let pick = nearest(origin, attrPool, used);
    if (pick) {
      plan.morning = pick.item;
      used.add(pick.item.xid);
      origin = { lat: pick.item.lat, lon: pick.item.lon };
    }

    // afternoon
    pick = nearest(origin, attrPool, used);
    if (pick) {
      plan.afternoon = pick.item;
      used.add(pick.item.xid);
      origin = { lat: pick.item.lat, lon: pick.item.lon };
    }

    // evening (restaurant)
    const anchor = plan.afternoon || plan.morning || { lat: dayStartPoint.lat, lon: dayStartPoint.lon };
    pick = nearest(anchor, restPool, used);
    if (pick) {
      plan.evening = pick.item;
      used.add(pick.item.xid);
    }

    dayPlans.push(plan);
  }

  lastItinerary = {
    title: `${tripPayload.destination || 'Trip'} Trip`,
    destination: tripPayload.destination || '',
    startDate: tripPayload.startDate || '',
    endDate: tripPayload.endDate || '',
    days: dayPlans,
    hotel: hotel || null
  };

  // fetch details (addresses & descriptions) for items used
  const toDetail = [];
  if (hotel) toDetail.push(hotel);
  dayPlans.forEach(p => { ['morning','afternoon','evening'].forEach(s => { if (p[s]) toDetail.push(p[s]); }); });
  await fetchDetailsBatch(toDetail);

  generatedItinerary.innerHTML = renderItineraryHTML(lastItinerary);
}

/* ---------------- Details (address/desc) ---------------- */

async function fetchDetailsBatch(items) {
  const unique = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || seen.has(it.xid)) continue;
    seen.add(it.xid);
    unique.push(it);
  }
  await Promise.all(unique.map(i => getPlaceDetails(i.xid).catch(()=>null)));
}

async function getPlaceDetails(xid) {
  if (detailsCache.has(xid)) return detailsCache.get(xid);
  const resp = await fetch(`https://api.opentripmap.com/0.1/en/places/xid/${xid}?apikey=${API_KEY}`);
  const data = await resp.json();
  const details = {
    name: data.name || "",
    address: formatAddress(data.address),
    desc: (data.wikipedia_extracts && data.wikipedia_extracts.text) || (data.info && data.info.descr) || "",
    url: data.otm || data.wikipedia || ""
  };
  detailsCache.set(xid, details);
  return details;
}

function formatAddress(addr) {
  if (!addr) return "";
  const parts = [addr.house_number, addr.road, addr.city || addr.town || addr.village, addr.state, addr.country];
  return parts.filter(Boolean).join(", ");
}

/* ---------------- Rendering ---------------- */

function slotLine(place, label, timeRange) {
  if (!place) return `<div><b>${label}</b> ${timeRange} — Free time</div>`;
  const d = detailsCache.get(place.xid);
  const name = place.name;
  const addr = d?.address ? `<div class="poi-note">${d.address}</div>` : "";
  const about = d?.desc ? `<div class="poi-note">${d.desc.slice(0,120)}${d.desc.length>120?'…':''}</div>` : "";
  return `<div style="margin-bottom:8px;">
    <b>${label}</b> ${timeRange} — ${name}
    ${addr}
    ${about}
  </div>`;
}

function renderItineraryHTML(it) {
  let html = `
    <div class="day-block" style="background:#f9fbfb;">
      <h3 style="margin:0 0 6px 0;">${it.title}</h3>
      <div>${it.startDate} → ${it.endDate}</div>
      ${it.hotel ? `<div class="poi-note"><b>Hotel:</b> ${it.hotel.name}</div>` : ""}
    </div>
  `;
  it.days.forEach(d => {
    html += `<div class="day-block">
      <h4 style="margin:0 0 6px 0;">Day ${d.day}</h4>
      ${slotLine(d.morning, "Morning", "09:00–12:00")}
      ${slotLine(d.afternoon, "Afternoon", "13:00–17:00")}
      ${slotLine(d.evening, "Evening", "19:00–21:00")}
    </div>`;
  });
  return html;
}

/* ---------------- Firestore Save ---------------- */

async function saveItinerary() {
  if (!currentUser) return alert("Sign in to save itinerary.");
  if (!lastItinerary) return alert("Generate itinerary first.");

  // save explicit fields so dashboard can read them reliably
  const payload = {
    title: lastItinerary.title || `${tripPayload.destination} Trip`,
    destination: tripPayload.destination || lastItinerary.destination || '',
    startDate: tripPayload.startDate || lastItinerary.startDate || '',
    endDate: tripPayload.endDate || lastItinerary.endDate || '',
    days: tripPayload.days || (lastItinerary.days ? lastItinerary.days.length : 1),
    budget: tripPayload.budget || null,
    companion: tripPayload.companion || null,
    createdAt: serverTimestamp(),
    itinerary: lastItinerary
  };

  try {
    await addDoc(collection(db, "users", currentUser.uid, "itineraries"), payload);
    alert("Itinerary saved!");
  } catch (err) {
    alert("Save failed: " + err.message);
  }
}

/* ---------------- PDF Export (styled) ---------------- */

/* ---------------- PDF Export (styled) ---------------- */

/* ---------------- PDF Export (styled) ---------------- */

async function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" }); // 595 x 842

  // Try to load logo (optional)
  const logoData = await tryLoadImageBase64(LOGO_URL).catch(()=>null);

  // Header band
  doc.setFillColor(...BRAND.color);
  doc.rect(0, 0, 595, 70, "F");

  // Logo or Title
  if (logoData) {
    try { doc.addImage(logoData, "PNG", 24, 16, 120, 38); } 
    catch(e) { drawBrandTitle(doc); }
  } else {
    drawBrandTitle(doc);
  }

  /* ---------------- CASE 1: AI itinerary (structured JSON) ---------------- */
  if (tripPayload?.aiItineraryStructured) {
    const s = tripPayload.aiItineraryStructured;
    doc.setFont("helvetica","bold");
    doc.setFontSize(16);
    doc.text(`${s.title || tripPayload.destination + " Trip Itinerary"}`, 24, 100);

    doc.setFont("helvetica","normal");
    doc.setFontSize(12);
    doc.text(`${s.startDate || tripPayload.startDate || ""} → ${s.endDate || tripPayload.endDate || ""} • ${tripPayload.days} day(s)`, 24, 118);

    let y = 150;

    (s.days || []).forEach((d, idx) => {
      const rows = [
        ["Morning", d.morning || "Free time"],
        ["Afternoon", d.afternoon || "Free time"],
        ["Evening", d.evening || "Free time"]
      ];

      doc.setFont("helvetica","bold");
      doc.setFontSize(14);
      doc.text(`Day ${idx+1}`, 24, y);
      y += 6;

      doc.autoTable({
        startY: y + 8,
        headStyles: { fillColor: BRAND.color },
        styles: { fontSize: 10, cellPadding: 6 },
        head: [["Slot", "Activity"]],
        body: rows
      });

      y = doc.lastAutoTable.finalY + 18;
      if (y > 760) { doc.addPage(); y = 60; }
    });

    doc.save(`${(tripPayload.destination || "trip")}_AI_itinerary.pdf`);
    return;
  }

  /* ---------------- CASE 2: AI itinerary (raw text) ---------------- */
  if (tripPayload?.aiItinerary && !lastItinerary) {
    doc.setFont("helvetica","bold");
    doc.setFontSize(16);
    doc.text(`${tripPayload.destination} Trip Itinerary`, 24, 100);

    doc.setFont("helvetica","normal");
    doc.setFontSize(12);
    doc.text(`${tripPayload.startDate || ""} → ${tripPayload.endDate || ""} • ${tripPayload.days} day(s)`, 24, 118);

    let y = 150;
    const lines = tripPayload.aiItinerary
      .split("\n")
      .map(l => l.trim())
      .filter(l => l);

    let dayRows = [];
    lines.forEach(line => {
      if (/^Day\s*\d+/i.test(line)) {
        // flush previous day's table
        if (dayRows.length) {
          doc.autoTable({
            startY: y,
            headStyles: { fillColor: BRAND.color },
            styles: { fontSize: 10, cellPadding: 6 },
            head: [["Time", "Activity"]],
            body: dayRows
          });
          y = doc.lastAutoTable.finalY + 20;
          dayRows = [];
        }
        doc.setFont("helvetica","bold");
        doc.setFontSize(14);
        doc.text(line, 24, y);
        y += 18;
      } else {
        // treat as "Slot: Activity"
        const parts = line.split(":");
        if (parts.length > 1) {
          dayRows.push([parts[0], parts.slice(1).join(":")]);
        } else {
          dayRows.push(["", line]);
        }
      }
    });

    // flush last day
    if (dayRows.length) {
      doc.autoTable({
        startY: y,
        headStyles: { fillColor: BRAND.color },
        styles: { fontSize: 10, cellPadding: 6 },
        head: [["Time", "Activity"]],
        body: dayRows
      });
    }

    doc.save(`${(tripPayload.destination || "trip")}_AI_itinerary.pdf`);
    return;
  }

  /* ---------------- CASE 3: POI-based itinerary ---------------- */
  if (!lastItinerary) return alert("Generate itinerary first.");

  doc.setFont("helvetica","bold");
  doc.setFontSize(16);
  doc.text(lastItinerary.title, 24, 100);
  doc.setFont("helvetica","normal");
  doc.setFontSize(12);
  doc.text(`${lastItinerary.startDate} → ${lastItinerary.endDate}`, 24, 118);
  if (lastItinerary.hotel) { doc.text(`Hotel: ${lastItinerary.hotel.name}`, 24, 136); }

  let y = 160;

  for (const d of lastItinerary.days) {
    const rows = [];
    const slots = [
      ["Morning", "09:00–12:00", d.morning],
      ["Afternoon", "13:00–17:00", d.afternoon],
      ["Evening", "19:00–21:00", d.evening]
    ];
    for (const [label, time, place] of slots) {
      if (!place) {
        rows.push([label, time, "Free time", ""]);
      } else {
        const det = detailsCache.get(place.xid);
        const name = place.name || "";
        const addr = det?.address || "";
        const about = det?.desc ? det.desc.slice(0,140) + (det.desc.length>140 ? "…" : "") : "";
        rows.push([label, time, name, addr || about]);
      }
    }

    doc.setFont("helvetica","bold");
    doc.setFontSize(14);
    doc.text(`Day ${d.day}`, 24, y);
    y += 6;

    doc.autoTable({
      startY: y + 8,
      headStyles: { fillColor: BRAND.color, halign: "left" },
      styles: { fontSize: 10, cellPadding: 6 },
      columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 90 }, 2: { cellWidth: 180 }, 3: { cellWidth: 200 } },
      head: [["Slot", "Time", "Place", "Notes"]],
      body: rows
    });

    y = doc.lastAutoTable.finalY + 18;
    if (y > 760) { doc.addPage(); y = 60; }
  }

  doc.save(`${(lastItinerary.destination || 'trip')}_itinerary.pdf`);
}


/* ---------------- Helpers ---------------- */

function drawBrandTitle(doc) {
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold");
  doc.setFontSize(18);
  doc.text(BRAND.name, 24, 44);
  doc.setTextColor(0,0,0);
}

function tryLoadImageBase64(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a)); // meters
}


/* ---------------- Load on open ---------------- */
function loadSavedIfAny() {
  // if user logged in and there's a loadedItinerary in sessionStorage, keep it visible;
  // otherwise run initial loader (the main function)
  loadFromSession();
}

loadFromSession();


