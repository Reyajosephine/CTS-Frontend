/* =========================================================
   Agri-Vision AI — app.js
   Config, API client (matches backend contract in the
   architecture doc), shared state, step navigation, toast.

   Files load in this order: app.js -> intake.js -> results.js
   All three attach to the single global `AgriVision` namespace
   so there is no bundler / module system required.
   ========================================================= */

window.AgriVision = (function () {

  /* -----------------------------------------------------
     CONFIG — the only two lines you touch to go live
     ----------------------------------------------------- */
  const CONFIG = {
    // Base URL of the FastAPI service
    BASE_URL: "https://agrivision-backend.happyrock-75c17763.centralindia.azurecontainerapps.io/",

    // Live Dempster-Shafer engine integration active
    MOCK_MODE: false,

    MAX_IMAGE_BYTES: 5 * 1024 * 1024, // 5MB, matches "up to 5MB" in the spec
    ACCEPTED_TYPES: ["image/jpeg", "image/png"],
  };

  /* -----------------------------------------------------
     Shared state for the current diagnosis session
     ----------------------------------------------------- */
  const state = {
    sessionId: null,
    step: "upload",       // upload | analyzing | question | result
    imageFile: null,
    top3: [],              // [{disease, probability}]
    candidateDiseases: [],
    currentQuestion: null, // {question_id, text, options}
    turn: 1,
    maxTurns: 5,
    questionsAsked: 0,
    finalResult: null,
  };

  /* -----------------------------------------------------
     Small helpers
     ----------------------------------------------------- */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  let toastTimer = null;
  function showToast(message, { persist = false } = {}) {
    const toast = $("#toast");
    if (!toast) return;
    const textEl = $("#toastText");
    if (textEl) textEl.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (!persist) {
      toastTimer = setTimeout(hideToast, 5000);
    }
  }
  function hideToast() {
    const toast = $("#toast");
    if (toast) toast.hidden = true;
  }

  /* -----------------------------------------------------
     Explanation Formatter Helper
     ----------------------------------------------------- */
  function formatExplanationContent(rawText) {
    if (!rawText || typeof rawText !== 'string') return '<p class="explanation">—</p>';

    // 1. Remove wrapping header text and concluding conversational filler
    let cleanText = rawText
      .replace(/^\*\*Management Recommendations[^\n:]+:\*\*\s*/i, '')
      .replace(/^#+\s+[^\n]+\n/i, '')
      .replace(/By following these steps[^\n.]+$/i, '')
      .trim();

    // 2. Split into distinct numbered sections (e.g., "1. **Pruning Practices:**")
    const sections = cleanText.split(/(?=\d+\.\s+\*\*)/g).filter(s => s.trim().length > 0);

    if (sections.length <= 1) {
      const formatted = cleanText
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n+/g, '<br>');
      return `<div class="explanation-formatted" style="line-height: 1.6;">${formatted}</div>`;
    }

    // 3. Construct structured HTML markup
    let html = '<div class="structured-explanation" style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem;">';

    sections.forEach(section => {
      // Extract Section Title
      const titleMatch = section.match(/\d+\.\s+\*\*([^*:]+):?\*\*/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // Extract Body Content following the title
      const bodyContent = titleMatch 
        ? section.replace(titleMatch[0], '').trim() 
        : section.trim();

      // Split sub-bullets by '-' delimiter or period boundaries
      const rawPoints = bodyContent.split(/\s*-\s+/).filter(Boolean);
      let points = [];

      if (rawPoints.length > 1) {
        points = rawPoints.map(p => p.replace(/[*#_]/g, '').trim()).filter(p => p.length > 2);
      } else {
        // Split on sentence boundaries if no hyphen bullets exist
        points = bodyContent
          .split(/(?<=[.!?])\s+/)
          .map(p => p.replace(/[*#_]/g, '').trim())
          .filter(p => p.length > 5);
      }

      html += `
        <div class="explanation-group" style="border-left: 3px solid var(--forest, #2d6a4f); padding-left: 0.75rem; margin-bottom: 0.5rem;">
          ${title ? `<div style="font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25rem;">${title}</div>` : ''}
          <ul style="font-size: 0.9rem; line-height: 1.5; padding-left: 1.25rem; margin: 0;">
            ${points.map(pt => `<li style="margin-bottom: 0.25rem;">${pt}</li>`).join('')}
          </ul>
        </div>
      `;
    });

    html += '</div>';
    return html;
  }

  /* -----------------------------------------------------
     Step navigation + step-rail state
     ----------------------------------------------------- */
  const STEP_ORDER = ["upload", "analyzing", "question", "result", "summary"];

  function goToStep(stepName) {
    state.step = stepName;

    $all(".panel").forEach(p => {
      p.classList.toggle("panel--active", p.dataset.step === stepName);
    });

    const idx = STEP_ORDER.indexOf(stepName);
    $all(".steprail__item").forEach(item => {
      const itemIdx = STEP_ORDER.indexOf(item.dataset.step);
      item.classList.toggle("is-current", itemIdx === idx);
      item.classList.toggle("is-done", itemIdx < idx);
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateSessionBadge() {
    const badge = $("#sessionBadge");
    if (!badge) return;
    if (state.sessionId) {
      badge.hidden = false;
      const textEl = $("#sessionBadgeText");
      if (textEl) textEl.textContent = `Session ${state.sessionId.slice(0, 8)}`;
    } else {
      badge.hidden = true;
    }
  }

  function resetSession() {
    state.sessionId = null;
    state.imageFile = null;
    state.top3 = [];
    state.candidateDiseases = [];
    state.currentQuestion = null;
    state.turn = 1;
    state.questionsAsked = 0;
    state.finalResult = null;
    sessionStorage.removeItem("agrivision_session_id");
    updateSessionBadge();
  }

  /* -----------------------------------------------------
     UNIFIED DIAGNOSIS RENDERER
     ----------------------------------------------------- */
  function renderDiagnosis(data) {
    if (!data) return;

    // Extract treatment plan from nested or top-level structure
    const plan = (data.diagnosis && data.diagnosis.treatment_plan)
      ? data.diagnosis.treatment_plan
      : (data.treatment_plan || data);

    state.finalResult = data;
    goToStep("result");

    // 1. Hide legacy raw text dump containers
    const rawContainers = document.querySelectorAll(
      '.diagnosis-overview-raw, #diag-raw-text, .raw-markdown, #treatment-overview, #diagnosis-overview'
    );
    rawContainers.forEach(el => {
      if (el.textContent.includes('**') || el.textContent.includes('####')) {
        el.style.display = 'none';
      }
    });

    const nameEl = $("#resultDiseaseName");
    if (nameEl) nameEl.textContent = data.diagnosed_disease || plan.disease || "Diagnosis";

    const sciEl = $("#resultScientificName");
    if (sciEl) {
      if (data.scientific_name) {
        sciEl.textContent = `(${data.scientific_name})`;
        sciEl.hidden = false;
      } else {
        sciEl.hidden = true;
      }
    }

    const pct = Math.round((data.confidence_score || 0) * 100);
    const ringEl = $("#ringPct");
    if (ringEl) ringEl.textContent = pct + "%";

    const statusEl = $("#statStatus");
    if (statusEl) statusEl.textContent = data.status || (pct >= 80 ? "Confirmed" : pct >= 55 ? "Likely" : "Uncertain");

    const candEl = $("#statCandidates");
    if (candEl) {
      const candidateCount = data.candidate_count || state.candidateDiseases.length || 1;
      candEl.textContent = `${candidateCount} Disease${candidateCount === 1 ? "" : "s"}`;
    }

    const qEl = $("#statQuestions");
    if (qEl) {
      const askedCount = data.questions_asked ?? state.questionsAsked ?? state.turn ?? 0;
      const maxCount = data.max_turns || state.maxTurns || askedCount;
      qEl.textContent = `${askedCount}/${maxCount}`;
    }

    const confEl = $("#statConflict");
    if (confEl) {
      confEl.textContent = (data.dst_conflict !== undefined && data.dst_conflict !== null)
        ? Number(data.dst_conflict).toFixed(2)
        : "—";
    }

    // Format Explanation Content
    const explanationTarget = document.getElementById('what-this-means-content')
      || document.getElementById('diagnosis-meaning')
      || document.querySelector('.what-this-means-body')
      || document.querySelector('.diagnosis-explanation')
      || $("#resultExplanation");

    if (explanationTarget) {
      const sourceText = data.explanation 
                      || data.meaning 
                      || data.description 
                      || (data.diagnosis && data.diagnosis.explanation) 
                      || '';
                      
      explanationTarget.innerHTML = formatExplanationContent(sourceText);
    }

    // 2. Hydrate the 4 Agronomic Summary Badges
    const setCardContent = (id, value, fallback) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = (value && String(value).trim().length > 0) ? String(value).trim() : fallback;
      }
    };

    setCardContent(
      'diag-root-cause',
      plan.root_cause,
      'Fungal/bacterial pathogen infection under humid conditions.'
    );
    setCardContent(
      'diag-recovery-time',
      plan.recovery_time_days,
      '7–14 days to arrest foliar spread with protective coverage.'
    );
    setCardContent(
      'diag-climate',
      plan.favorable_climate,
      'Warm, humid weather (20°C–28°C) with persistent leaf wetness.'
    );
    setCardContent(
      'diag-landscape',
      plan.landscape_and_soil,
      'Dense canopies and low-lying plots with poor air drainage.'
    );

    // 3. Defensive List Renderer (Prevents single-character iteration)
    const renderList = (elementId, rawItems, defaultItem) => {
      const container = document.getElementById(elementId) || (selector => document.querySelector(selector))(elementId.startsWith("#") ? elementId : `#${elementId}`);
      if (!container) return;
      container.innerHTML = '';

      let items = [];

      if (Array.isArray(rawItems)) {
        items = rawItems.map(item => {
          if (typeof item === 'object' && item !== null) {
            return item.description || item.remedy || item.title || JSON.stringify(item);
          }
          return String(item);
        });
      } else if (typeof rawItems === 'string' && rawItems.trim().length > 0) {
        items = rawItems
          .split(/\n+|\s*\d+\.\s+|\s*[-*•]\s+/)
          .map(s => s.replace(/[*#_]/g, '').trim())
          .filter(s => s.length > 3);
      }

      if (items.length === 0 && defaultItem) {
        items = [defaultItem];
      }

      items.forEach(text => {
        const li = document.createElement('li');
        li.className = 'mb-2 text-start';
        li.textContent = text;
        container.appendChild(li);
      });
    };

    // 4. Hydrate Management and Prevention Lists
    renderList(
      '#managementList',
      plan.chemical_treatments || plan.management || plan.biological_controls || data.management_recommendations,
      'Apply registered protective fungicides or bactericides following label instructions.'
    );

    renderList(
      '#preventionList',
      plan.cultural_preventive_measures || plan.prevention || data.prevention_strategies,
      'Prune canopy foliage, improve airflow, and avoid overhead sprinkler irrigation.'
    );

    renderList(
      'management-list',
      plan.chemical_treatments || plan.management,
      'Apply registered protective fungicides or bactericides following label instructions.'
    );

    renderList(
      'prevention-list',
      plan.cultural_preventive_measures || plan.prevention,
      'Prune canopy foliage, improve airflow, and avoid overhead sprinkler irrigation.'
    );

    renderList(
      'bio-controls-list',
      plan.biological_controls,
      'Apply Bacillus subtilis or Trichoderma-based bio-fungicides.'
    );

    renderList(
      'chemical-treatments-list',
      plan.chemical_treatments,
      'Apply registered protective fungicides on a 7–10 day protective schedule.'
    );
  }

  // Make globally accessible for direct debugging in console
  window.renderDiagnosis = renderDiagnosis;
  window.formatExplanationContent = formatExplanationContent;

  /* -----------------------------------------------------
     API client
     ----------------------------------------------------- */

  async function apiRequest(path, options = {}) {
    let url = CONFIG.BASE_URL;
    if (path.startsWith("/api/v1/diagnosis")) {
      const baseHost = CONFIG.BASE_URL.replace(/\/api\/v1\/diagnosis\/?$/, "");
      url = baseHost + path;
    } else {
      url = CONFIG.BASE_URL.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    }
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      throw new ApiError("network", "Can't reach the server. Check your connection and try again.");
    }

    if (res.ok) {
      return res.status === 204 ? null : res.json();
    }

    let body = {};
    try { body = await res.json(); } catch (_) { /* no body */ }

    const messages = {
      404: "That diagnosis session couldn't be found.",
      409: "That question is out of date — refreshing with the current one.",
      410: "This session has expired. Please start a new diagnosis.",
      422: "That image couldn't be processed. Try a clearer JPG or PNG under 5MB.",
      503: "The diagnosis service is temporarily unavailable. Please try again shortly.",
    };
    throw new ApiError(res.status, body.error || messages[res.status] || "Something went wrong. Please try again.", body);
  }

  class ApiError extends Error {
    constructor(status, message, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  const API = {
    async startDiagnosis(imageFile) {
      if (CONFIG.MOCK_MODE) return Mock.start(imageFile);
      const form = new FormData();
      form.append("image", imageFile);
      return apiRequest("/api/v1/diagnosis/start", { method: "POST", body: form });
    },

    async answerQuestion(sessionId, questionId, answer) {
      if (CONFIG.MOCK_MODE) return Mock.answer(sessionId, questionId, answer);
      return apiRequest(`/api/v1/diagnosis/${sessionId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: questionId, answer }),
      });
    },

    async getResult(sessionId) {
      if (CONFIG.MOCK_MODE) return Mock.result(sessionId);
      return apiRequest(`/api/v1/diagnosis/${sessionId}/result`, { method: "GET" });
    },

    async getStatus(sessionId) {
      if (CONFIG.MOCK_MODE) return { status: "complete" };
      return apiRequest(`/api/v1/diagnosis/${sessionId}/status`, { method: "GET" });
    },

    async followup(sessionId, question) {
      if (CONFIG.MOCK_MODE) return Mock.followup(question);
      return apiRequest(`/api/v1/diagnosis/${sessionId}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
    },
  };

  const MOCK_QUESTIONS = [
    { question_id: "q_lesion_color", text: "Do you see circular brown spots with concentric rings on the leaf?" },
    { question_id: "q_older_leaves", text: "Are the older, lower leaves affected first?" },
    { question_id: "q_stem_lesions", text: "Are there any dark lesions on the stem?" },
    { question_id: "q_leaf_yellowing", text: "Is there yellowing around the spots?" },
    { question_id: "q_moist_conditions", text: "Has the plant been in unusually humid or wet conditions?" },
  ];

  const Mock = {
    async start(imageFile) {
      await wait(400);
      const sessionId = "mock-" + Math.random().toString(36).slice(2, 10);
      const top3 = [
        { disease: "Early Blight", probability: 0.62 },
        { disease: "Late Blight", probability: 0.25 },
        { disease: "Leaf Mold", probability: 0.13 },
      ];
      return {
        session_id: sessionId,
        status: "awaiting_answer",
        top3_predictions: top3,
        candidate_diseases: ["Early Blight", "Late Blight"],
        current_question: { question_id: MOCK_QUESTIONS[0].question_id, text: MOCK_QUESTIONS[0].text, options: ["yes", "no", "not_sure"] },
        turn: 1,
        max_turns: 5,
      };
    },

    async answer(sessionId, questionId, answer) {
      await wait(350);
      const turn = (state.turn || 1) + 1;
      if (turn > state.maxTurns) {
        return Mock.result(sessionId);
      }
      const next = MOCK_QUESTIONS[turn - 1] || MOCK_QUESTIONS[MOCK_QUESTIONS.length - 1];
      return {
        session_id: sessionId,
        status: "awaiting_answer",
        candidate_diseases: answer === "yes" ? ["Early Blight"] : ["Early Blight", "Late Blight"],
        current_question: { question_id: next.question_id, text: next.text, options: ["yes", "no", "not_sure"] },
        turn,
        max_turns: state.maxTurns,
      };
    },

    async result() {
      await wait(300);
      return {
        session_id: state.sessionId,
        status: "complete",
        result: {
          diagnosed_disease: "Early Blight",
          scientific_name: "Alternaria solani",
          confidence_score: 0.78,
          confidence_note: "mvp_candidate_set",
          status: "Likely",
          candidate_count: 2,
          questions_asked: 5,
          max_turns: 5,
          dst_conflict: 0.04,
          management_recommendations: [
            "Remove and destroy infected leaves",
            "Maintain good field sanitation",
            "Improve air circulation between plants",
            "Use fungicides if disease pressure is high",
          ],
          prevention_strategies: [
            "Avoid prolonged leaf wetness",
            "Use resistant varieties where possible",
            "Maintain proper plant spacing",
            "Rotate crops each season",
          ],
          references: ["https://extension.umn.edu/disease/early-blight-tomato-and-potato"],
          explanation: "Based on the concentric ring pattern on the leaf and the fact that older leaves were affected first, this points to Early Blight rather than Late Blight or Leaf Mold. The combination of the visual pattern and the symptoms you confirmed gives a strong match.",
        },
      };
    },

    async followup(question) {
      await wait(500);
      return { answer: "To prevent Early Blight in the future, avoid prolonged leaf wetness, maintain good field sanitation, use resistant varieties, and ensure proper plant spacing for good air circulation." };
    },
  };

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  document.addEventListener("DOMContentLoaded", () => {
    const toastClose = $("#toastClose");
    if (toastClose) toastClose.addEventListener("click", hideToast);
    goToStep("upload");
  });

  return {
    CONFIG, state, API, ApiError,
    $, $all, formatBytes, showToast, hideToast,
    goToStep, updateSessionBadge, resetSession, renderDiagnosis, formatExplanationContent,
  };
})();