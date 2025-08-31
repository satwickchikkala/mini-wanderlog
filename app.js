// public/scripts/app.js
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, getDocs, deleteDoc, doc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let currentUser = null;

// UI elements
const userInfo = document.getElementById('userInfo');
const logoutBtn = document.getElementById('logoutBtn');
const startBtn = document.getElementById('startBtn');
const goPlanner = document.getElementById('goPlanner');
const savedTripsEl = document.getElementById('savedTrips');

// ---------------- AUTH ----------------
onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    userInfo.innerText = `Signed in: ${user.email || user.displayName || 'User'}`;
    loadSavedTrips();
  } else {
    userInfo.innerText = 'Not signed in';
    savedTripsEl.innerHTML = 'Sign in to view saved trips.';
  }
});

logoutBtn?.addEventListener('click', async () => {
  await signOut(auth);
  window.location.href = 'index.html';
});

goPlanner?.addEventListener('click', () => {
  window.location.href = 'planner.html';
});

// ---------------- TRIP CREATION ----------------
startBtn?.addEventListener('click', () => {
  const destination = document.getElementById('destination').value.trim();
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const daysInput = parseInt(document.getElementById('days').value || '0', 10);
  const budget = document.getElementById('budget').value;
  const aiAssistant = document.getElementById('aiAssistant')?.checked || false;
  const companion = document.getElementById('companion')?.value || 'none';

  if (!destination) return alert('Please enter a destination');

  let days = 0;
  if (startDate && endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    const diff = Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
    if (diff > 0) days = diff;
  }
  if (!days && daysInput > 0) days = daysInput;
  if (!days) days = 3;

  const payload = { destination, startDate, endDate, days, budget, aiAssistant, companion };
  sessionStorage.setItem('tripPayload', JSON.stringify(payload));

  if (aiAssistant) {
    openAssistantDialog(payload);
  } else {
    window.location.href = 'planner.html';
  }
});

// ---------------- Hugging Face AI Assistant ----------------

async function openAssistantDialog(basePayload) {
  const HF_API_KEY = "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"; // <-- REPLACE with your Hugging Face key
  const PRIMARY_MODEL = "bigscience/bloomz-560m";     // primary generation-capable model
  const FALLBACK_MODEL = "facebook/bart-large-cnn";   // fallback

  // Ask user extra preferences
  const pace = (prompt("What pace do you prefer? (relaxed / balanced / packed)")) || "balanced";
  const interests = (prompt("What are your interests? (food, history, nature, shopping, nightlife)")) || "general sightseeing";
  const mustSee = (prompt("Any must-visit places? (comma separated)")) || "none";

  // Request JSON output for robust parsing
  const promptText = `
You are a professional travel planner. Produce a detailed itinerary in JSON ONLY (no additional text).
Fields:
{
  "title": string,
  "destination": string,
  "startDate": string,
  "endDate": string,
  "days": [
    {
      "day": 1,
      "morning": "string (what to do)",
      "afternoon": "string",
      "evening": "string"
    }
  ],
  "notes": "optional summary"
}

Now create a JSON itinerary for a ${basePayload.days}-day trip to ${basePayload.destination}.
Dates: ${basePayload.startDate || "N/A"} - ${basePayload.endDate || "N/A"}.
Budget: ${basePayload.budget || "flexible"} USD.
Companion: ${basePayload.companion}.
Pace: ${pace}.
Interests: ${interests}.
Must-see: ${mustSee}.

Make exactly ${basePayload.days} day objects (Day 1 ... Day ${basePayload.days}).
Respond ONLY with the JSON described above.
`;

  // call HF model and return string output
  async function callModel(model) {
    const resp = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: promptText,
        parameters: { max_new_tokens: 900, temperature: 0.6 }
      }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      // throw with body (useful debugging)
      throw new Error(`Model ${model} failed: ${resp.status} ${text}`);
    }

    // Many HF models return JSON array like [{"generated_text":"..."}]
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed[0]) {
        if (parsed[0].generated_text) return parsed[0].generated_text;
        if (parsed[0].summary_text) return parsed[0].summary_text;
        if (parsed[0].output_text) return parsed[0].output_text;
      }
    } catch (e) {
      // not JSON - keep raw text
    }
    // If it's plain text, return it
    return text;
  }

  // helper: try to extract JSON block from a text (handles ```json ... ``` and plain {...})
  function extractJSONFromText(raw) {
    if (!raw || typeof raw !== "string") return null;
    // 1) Look for triple-backtick json block
    let m = raw.match(/```json\s*([\s\S]*?)```/i);
    if (m && m[1]) {
      try { return JSON.parse(m[1].trim()); } catch(e){ /* fallthrough */ }
    }
    // 2) Look for first { and last } (best-effort)
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      const sub = raw.slice(first, last + 1);
      try { return JSON.parse(sub); } catch(e) { /* fallthrough */ }
    }
    // 3) If response itself is pure JSON string already
    try { return JSON.parse(raw); } catch(e){ /* no JSON */ }
    return null;
  }

  // helper: fallback parser (text -> structured days)
  function parseTextToDays(rawText, numDays) {
    const out = [];
    if (!rawText || !rawText.trim()) {
      for (let i=0;i<numDays;i++) out.push({day: i+1, morning: "", afternoon: "", evening: ""});
      return out;
    }

    // Try to find start at first "Day 1"
    let idx = rawText.search(/(^|\n)\s*Day\s*1\b/i);
    let text = rawText;
    if (idx !== -1) text = rawText.slice(idx);

    // Split into day blocks using a robust regex (lookahead for Day N)
    const daySplit = text.split(/(?=\n\s*Day\s*\d+\b)/i).map(s => s.trim()).filter(Boolean);

    for (let i = 0; i < numDays; i++) {
      const block = daySplit[i] || "";
      // extract Morning / Afternoon / Evening contents
      function getSlot(b, slot) {
        const re = new RegExp(slot + '\\s*[:\\-]\\s*([\\s\\S]*?)(?=(\\n\\s*(Morning|Afternoon|Evening|Day\\s*\\d+)|$))', 'i');
        const m = b.match(re);
        if (m && m[1]) return m[1].trim().replace(/^-+\s*/,'').replace(/\n+/g,' ').trim();
        // try dashed list like "- Morning: ..."
        const lineRe = new RegExp('(?:\\n|^)[\\s\\-]*' + slot + '\\s*[:\\-]\\s*(.*)', 'i');
        const lm = b.match(lineRe);
        if (lm && lm[1]) return lm[1].trim();
        return "";
      }
      out.push({
        day: i+1,
        morning: getSlot(block, "Morning"),
        afternoon: getSlot(block, "Afternoon"),
        evening: getSlot(block, "Evening")
      });
    }
    return out;
  }

  try {
    // try primary, fallback if error
    let rawOutput;
    try {
      rawOutput = await callModel(PRIMARY_MODEL);
    } catch (err) {
      console.warn("Primary model failed:", err.message);
      rawOutput = await callModel(FALLBACK_MODEL);
    }

    // Try to extract JSON out of the returned text
    const parsedJson = extractJSONFromText(rawOutput);

    let structured = null;
    if (parsedJson && Array.isArray(parsedJson.days)) {
      // use as-is if valid structure
      structured = {
        title: parsedJson.title || `${basePayload.destination} Trip`,
        destination: parsedJson.destination || basePayload.destination,
        startDate: parsedJson.startDate || basePayload.startDate || "",
        endDate: parsedJson.endDate || basePayload.endDate || "",
        days: parsedJson.days.slice(0, basePayload.days).map((d, i) => ({
          day: (d.day || i+1),
          morning: (d.morning || "").trim(),
          afternoon: (d.afternoon || "").trim(),
          evening: (d.evening || "").trim()
        })),
        notes: parsedJson.notes || ""
      };
    } else {
      // fallback: try to parse raw text into days
      const dayObjs = parseTextToDays(rawOutput, basePayload.days);
      structured = {
        title: `${basePayload.destination} Trip`,
        destination: basePayload.destination,
        startDate: basePayload.startDate || "",
        endDate: basePayload.endDate || "",
        days: dayObjs,
        notes: ""
      };
    }

    // Save both raw text and structured JSON into session
    const finalPayload = {
      ...basePayload,
      aiItineraryRaw: rawOutput,
      aiItineraryStructured: structured
    };
    sessionStorage.setItem('tripPayload', JSON.stringify(finalPayload));
    // redirect to planner where planner.js will pick it up and render
    window.location.href = 'planner.html';
  } catch (err) {
    alert("AI Assistant failed: " + err.message);
    console.error(err);
    // fallback to planner without AI result
    sessionStorage.setItem('tripPayload', JSON.stringify(basePayload));
    window.location.href = 'planner.html';
  }
}

// ---------------- SAVED TRIPS ----------------
async function loadSavedTrips() {
  if (!currentUser) return;
  savedTripsEl.innerHTML = 'Loading...';

  try {
    const q = query(collection(db, 'users', currentUser.uid, 'itineraries'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      savedTripsEl.innerHTML = 'No saved trips.';
      return;
    }

    savedTripsEl.innerHTML = '';
    snap.forEach(docSnap => {
      const data = docSnap.data();
      const id = docSnap.id;

      const title = data.destination || data.title || 'Untitled Trip';
      const start = data.startDate || '';
      const end = data.endDate || '';
      const companion = data.companion || '';
      const created = data.createdAt ? new Date(data.createdAt.seconds * 1000).toLocaleDateString() : '';

      const card = document.createElement('div');
      card.className = 'tripCard';
      card.innerHTML = `
        <h4>${title}</h4>
        <small>${start} ${end ? ` - ${end}` : ''}</small>
        ${companion ? `<div><small>Companion: ${companion}</small></div>` : ''}
        ${created ? `<div><small>Saved: ${created}</small></div>` : ''}
        <div style="margin-top:8px;">
          <button class="viewBtn" data-id="${id}">View</button>
          <button class="deleteBtn" data-id="${id}">Delete</button>
        </div>
      `;
      savedTripsEl.appendChild(card);
    });

    document.querySelectorAll('.viewBtn').forEach(btn =>
      btn.addEventListener('click', async e => {
        const id = e.target.dataset.id;
        const docs = await getDocs(collection(db, 'users', currentUser.uid, 'itineraries'));
        for (const s of docs.docs) {
          if (s.id === id) {
            sessionStorage.setItem('loadedItinerary', JSON.stringify({ id: s.id, ...s.data() }));
            window.location.href = 'planner.html';
            return;
          }
        }
        alert('Could not load itinerary.');
      })
    );

    document.querySelectorAll('.deleteBtn').forEach(btn =>
      btn.addEventListener('click', async e => {
        const id = e.target.dataset.id;
        if (!confirm('Delete this itinerary?')) return;
        try {
          await deleteDoc(doc(db, 'users', currentUser.uid, 'itineraries', id));
          loadSavedTrips();
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      })
    );
  } catch (err) {
    console.error(err);
    savedTripsEl.innerHTML = 'Failed to load trips: ' + err.message;
  }
}
