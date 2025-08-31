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

// ---------------- Enhanced AI Assistant with Modal Dialog ----------------

async function openAssistantDialog(basePayload) {
  const HF_API_KEY = "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"; // <-- REPLACE with your Hugging Face key
  const PRIMARY_MODEL = "bigscience/bloomz-560m";     // primary generation-capable model
  const FALLBACK_MODEL = "facebook/bart-large-cnn";   // fallback

  // Create modal dialog that matches your existing design
  const modalHTML = `
    <div id="aiAssistantModal" class="ai-modal-overlay">
      <div class="ai-modal">
        <div class="ai-modal-header">
          <h3>🤖 AI Travel Assistant</h3>
          <p>Help me personalize your perfect trip to ${basePayload.destination}</p>
        </div>
        
        <div class="ai-modal-body">
          <div class="ai-question">
            <label>What pace do you prefer for your trip?</label>
            <select id="aiPace" required>
              <option value="">Select your preferred pace...</option>
              <option value="relaxed">🌸 Relaxed - Take it slow, enjoy the moments</option>
              <option value="balanced">⚖️ Balanced - Mix of activities and rest</option>
              <option value="packed">⚡ Packed - See and do everything possible</option>
            </select>
          </div>
          
          <div class="ai-question">
            <label>What are your main interests? (Select multiple)</label>
            <div class="ai-interests-grid">
              <label class="ai-interest-option">
                <input type="checkbox" value="food" />
                <span>🍜 Food & Cuisine</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="history" />
                <span>🏛️ History & Culture</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="nature" />
                <span>🌲 Nature & Outdoors</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="shopping" />
                <span>🛍️ Shopping</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="nightlife" />
                <span>🌙 Nightlife</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="art" />
                <span>🎨 Art & Museums</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="adventure" />
                <span>🏔️ Adventure Sports</span>
              </label>
              <label class="ai-interest-option">
                <input type="checkbox" value="wellness" />
                <span>🧘 Wellness & Relaxation</span>
              </label>
            </div>
          </div>
          
          <div class="ai-question">
            <label>Any must-visit places or specific requests?</label>
            <textarea id="aiMustSee" placeholder="Enter specific places, activities, or experiences you don't want to miss... (Optional)" rows="3"></textarea>
          </div>
        </div>
        
        <div class="ai-modal-footer">
          <button id="aiCancel" class="ai-btn-cancel">Cancel</button>
          <button id="aiGenerate" class="ai-btn-generate">
            <span class="ai-btn-text">✨ Generate My Itinerary</span>
            <div class="ai-btn-loader" style="display: none;">
              <div class="ai-spinner"></div>
              <span>Creating magic...</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  `;

  // Add modal styles that match your existing design
  const modalStyles = `
    <style id="aiModalStyles">
      .ai-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        opacity: 0;
        animation: aiModalFadeIn 0.3s ease-out forwards;
      }
      
      @keyframes aiModalFadeIn {
        to { opacity: 1; }
      }
      
      .ai-modal {
        background: rgba(255, 255, 255, 0.98);
        backdrop-filter: blur(20px);
        border-radius: 24px;
        max-width: 600px;
        width: 90%;
        max-height: 85vh;
        overflow-y: auto;
        border: 1px solid rgba(255, 255, 255, 0.3);
        box-shadow: 0 25px 50px rgba(0, 0, 0, 0.15);
        transform: scale(0.9) translateY(20px);
        animation: aiModalSlideIn 0.3s ease-out 0.1s forwards;
      }
      
      @keyframes aiModalSlideIn {
        to {
          transform: scale(1) translateY(0);
        }
      }
      
      .ai-modal-header {
        padding: 30px 30px 20px;
        text-align: center;
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        border-radius: 24px 24px 0 0;
      }
      
      .ai-modal-header h3 {
        font-size: 1.6rem;
        font-weight: 700;
        margin-bottom: 8px;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      }
      
      .ai-modal-header p {
        font-size: 1rem;
        opacity: 0.95;
        font-weight: 400;
      }
      
      .ai-modal-body {
        padding: 30px;
        display: flex;
        flex-direction: column;
        gap: 25px;
      }
      
      .ai-question {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .ai-question label {
        font-size: 1.1rem;
        font-weight: 600;
        color: #2d3748;
      }
      
      .ai-question select,
      .ai-question textarea {
        padding: 14px 16px;
        border: 2px solid #e2e8f0;
        border-radius: 12px;
        font-size: 1rem;
        background: white;
        transition: all 0.3s ease;
        outline: none;
        font-family: inherit;
      }
      
      .ai-question select:focus,
      .ai-question textarea:focus {
        border-color: #667eea;
        box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        transform: translateY(-1px);
      }
      
      .ai-question select option {
        padding: 10px;
        font-size: 1rem;
      }
      
      .ai-question textarea {
        resize: vertical;
        min-height: 80px;
      }
      
      .ai-question textarea::placeholder {
        color: #a0aec0;
      }
      
      .ai-interests-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px;
      }
      
      .ai-interest-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px;
        background: #f7fafc;
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.3s ease;
        border: 2px solid transparent;
        font-weight: 500;
      }
      
      .ai-interest-option:hover {
        background: #edf2f7;
        transform: translateY(-1px);
      }
      
      .ai-interest-option input[type="checkbox"] {
        width: 18px;
        height: 18px;
        accent-color: #667eea;
        margin: 0;
      }
      
      .ai-interest-option input[type="checkbox"]:checked + span {
        color: #667eea;
        font-weight: 600;
      }
      
      .ai-interest-option:has(input:checked) {
        background: rgba(102, 126, 234, 0.1);
        border-color: #667eea;
      }
      
      .ai-modal-footer {
        padding: 20px 30px 30px;
        display: flex;
        gap: 15px;
        justify-content: flex-end;
      }
      
      .ai-btn-cancel {
        padding: 12px 24px;
        border: 2px solid #e2e8f0;
        border-radius: 12px;
        background: white;
        color: #4a5568;
        font-size: 1rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      
      .ai-btn-cancel:hover {
        background: #f7fafc;
        border-color: #cbd5e0;
        transform: translateY(-1px);
      }
      
      .ai-btn-generate {
        padding: 12px 24px;
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        border: none;
        border-radius: 12px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
        min-width: 200px;
      }
      
      .ai-btn-generate:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
      }
      
      .ai-btn-generate:disabled {
        opacity: 0.8;
        cursor: not-allowed;
      }
      
      .ai-btn-loader {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      }
      
      .ai-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top: 2px solid white;
        border-radius: 50%;
        animation: aiSpin 1s linear infinite;
      }
      
      @keyframes aiSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      
      /* Validation styles */
      .ai-question.error select,
      .ai-question.error textarea {
        border-color: #e53e3e;
        box-shadow: 0 0 0 3px rgba(229, 62, 62, 0.1);
      }
      
      .ai-error-message {
        color: #e53e3e;
        font-size: 0.9rem;
        font-weight: 500;
      }
      
      .ai-interests-error {
        color: #e53e3e;
        font-size: 0.9rem;
        font-weight: 500;
        margin-top: 8px;
      }
      
      /* Mobile responsive */
      @media (max-width: 768px) {
        .ai-modal {
          width: 95%;
          margin: 10px;
        }
        
        .ai-modal-header {
          padding: 20px 20px 15px;
        }
        
        .ai-modal-body {
          padding: 20px;
        }
        
        .ai-modal-footer {
          padding: 15px 20px 20px;
          flex-direction: column-reverse;
        }
        
        .ai-btn-cancel,
        .ai-btn-generate {
          width: 100%;
          justify-content: center;
        }
        
        .ai-interests-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  `;

  // Add styles and modal to page
  document.head.insertAdjacentHTML('beforeend', modalStyles);
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const modal = document.getElementById('aiAssistantModal');
  const cancelBtn = document.getElementById('aiCancel');
  const generateBtn = document.getElementById('aiGenerate');
  const generateBtnText = generateBtn.querySelector('.ai-btn-text');
  const generateBtnLoader = generateBtn.querySelector('.ai-btn-loader');

  // Validation function
  function validateForm() {
    let isValid = true;
    
    // Clear previous errors
    document.querySelectorAll('.ai-question.error').forEach(q => q.classList.remove('error'));
    document.querySelectorAll('.ai-error-message').forEach(e => e.remove());
    document.querySelectorAll('.ai-interests-error').forEach(e => e.remove());
    
    // Validate pace selection
    const pace = document.getElementById('aiPace').value;
    if (!pace) {
      const paceQuestion = document.getElementById('aiPace').closest('.ai-question');
      paceQuestion.classList.add('error');
      paceQuestion.insertAdjacentHTML('beforeend', '<div class="ai-error-message">Please select your preferred pace</div>');
      isValid = false;
    }
    
    // Validate interests selection (at least one)
    const selectedInterests = Array.from(document.querySelectorAll('.ai-interest-option input[type="checkbox"]:checked'));
    if (selectedInterests.length === 0) {
      const interestsGrid = document.querySelector('.ai-interests-grid');
      interestsGrid.insertAdjacentHTML('afterend', '<div class="ai-interests-error">Please select at least one interest</div>');
      isValid = false;
    }
    
    return isValid;
  }

  // Handle form submission
  generateBtn.addEventListener('click', async () => {
    if (!validateForm()) {
      return;
    }

    // Get form values
    const pace = document.getElementById('aiPace').value;
    const selectedInterests = Array.from(document.querySelectorAll('.ai-interest-option input[type="checkbox"]:checked')).map(cb => cb.value);
    const interests = selectedInterests.join(', ') || 'general sightseeing';
    const mustSee = document.getElementById('aiMustSee').value.trim() || 'none';

    // Show loading state
    generateBtn.disabled = true;
    generateBtnText.style.display = 'none';
    generateBtnLoader.style.display = 'flex';

    try {
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
          throw new Error(`Model ${model} failed: ${resp.status} ${text}`);
        }

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
        return text;
      }

      // helper: try to extract JSON block from a text
      function extractJSONFromText(raw) {
        if (!raw || typeof raw !== "string") return null;
        let m = raw.match(/```json\s*([\s\S]*?)```/i);
        if (m && m[1]) {
          try { return JSON.parse(m[1].trim()); } catch(e){ /* fallthrough */ }
        }
        const first = raw.indexOf('{');
        const last = raw.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
          const sub = raw.slice(first, last + 1);
          try { return JSON.parse(sub); } catch(e) { /* fallthrough */ }
        }
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

        let idx = rawText.search(/(^|\n)\s*Day\s*1\b/i);
        let text = rawText;
        if (idx !== -1) text = rawText.slice(idx);

        const daySplit = text.split(/(?=\n\s*Day\s*\d+\b)/i).map(s => s.trim()).filter(Boolean);

        for (let i = 0; i < numDays; i++) {
          const block = daySplit[i] || "";
          function getSlot(b, slot) {
            const re = new RegExp(slot + '\\s*[:\\-]\\s*([\\s\\S]*?)(?=(\\n\\s*(Morning|Afternoon|Evening|Day\\s*\\d+)|$))', 'i');
            const m = b.match(re);
            if (m && m[1]) return m[1].trim().replace(/^-+\s*/,'').replace(/\n+/g,' ').trim();
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

      // Save enhanced payload with user preferences
      const finalPayload = {
        ...basePayload,
        aiPreferences: {
          pace,
          interests: selectedInterests,
          mustSee
        },
        aiItineraryRaw: rawOutput,
        aiItineraryStructured: structured
      };
      
      sessionStorage.setItem('tripPayload', JSON.stringify(finalPayload));
      
      // Close modal and redirect
      modal.remove();
      document.getElementById('aiModalStyles').remove();
      window.location.href = 'planner.html';

    } catch (err) {
      alert("AI Assistant failed: " + err.message);
      console.error(err);
      
      // Close modal and fallback to planner without AI result
      modal.remove();
      document.getElementById('aiModalStyles').remove();
      sessionStorage.setItem('tripPayload', JSON.stringify(basePayload));
      window.location.href = 'planner.html';
    }
  });

  // Handle cancel
  cancelBtn.addEventListener('click', () => {
    modal.remove();
    document.getElementById('aiModalStyles').remove();
    // Continue without AI assistance
    window.location.href = 'planner.html';
  });

  // Close modal on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      cancelBtn.click();
    }
  });
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
