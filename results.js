/* =========================================================
   Agri-Vision AI — results.js
   Step 3/4: adaptive symptom questions.
   Final: diagnosis result, recommendations, follow-up Q&A.
   ========================================================= */

AgriVision.Results = (function (A) {
  const { $, $all, state, API, showToast, goToStep } = A;

  function init() {
    $("#questionOptions").addEventListener("click", onAnswerClick);
    $("#followupForm").addEventListener("submit", onFollowupSubmit);
    $("#toSummaryBtn").addEventListener("click", () => showSummary(state.finalResult));
    $("#downloadReportBtn").addEventListener("click", downloadReport);
    $("#toggleRecsBtn").addEventListener("click", toggleRecommendations);
  }

  /* -----------------------------------------------------
     Explanation Formatter Helper
     ----------------------------------------------------- */
  function formatExplanationContent(rawText) {
    if (!rawText || typeof rawText !== 'string') return '<p class="explanation">—</p>';

    let cleanText = rawText
      .replace(/^\*\*Management Recommendations[^\n:]+:\*\*\s*/i, '')
      .replace(/^#+\s+[^\n]+\n/i, '')
      .replace(/By following these steps[^\n.]+$/i, '')
      .trim();

    const sections = cleanText.split(/(?=\d+\.\s+\*\*)/g).filter(s => s.trim().length > 0);

    if (sections.length <= 1) {
      const formatted = cleanText
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n+/g, '<br>');
      return `<p class="explanation" style="line-height: 1.6;">${formatted}</p>`;
    }

    let html = '<div class="structured-explanation" style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem;">';

    sections.forEach(section => {
      const titleMatch = section.match(/\d+\.\s+\*\*([^*:]+):?\*\*/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      const bodyContent = titleMatch 
        ? section.replace(titleMatch[0], '').trim() 
        : section.trim();

      const rawPoints = bodyContent.split(/\s*-\s+/).filter(Boolean);
      let points = [];

      if (rawPoints.length > 1) {
        points = rawPoints.map(p => p.replace(/[*#_]/g, '').trim()).filter(p => p.length > 2);
      } else {
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
     Questions (steps 3 & 4 of the flow)
     ----------------------------------------------------- */
  function showQuestion(question, turn, maxTurns) {
    state.currentQuestion = question;
    state.turn = turn;
    state.maxTurns = maxTurns;

    goToStep("question");

    $("#questionEyebrow").textContent = turn <= 1 ? "Step 3 · Narrowing it down" : "Step 4 · Narrowing it down";
    $("#qProgressText").textContent = `Question ${turn} of ${maxTurns}`;
    $("#questionText").textContent = question.text;
    $("#questionTip").textContent = turn >= maxTurns
      ? "One more answer and we'll have your diagnosis."
      : "Your answer helps narrow down the possibilities.";

    renderProgressSegments(turn, maxTurns);
    resetAnswerButtons();
  }

  function renderProgressSegments(turn, maxTurns) {
    const track = $("#qProgressTrack");
    track.innerHTML = "";
    for (let i = 1; i <= maxTurns; i++) {
      const seg = document.createElement("span");
      seg.className = "qseg";
      if (i < turn) seg.classList.add("is-filled");
      if (i === turn) seg.classList.add("is-current");
      track.appendChild(seg);
    }
  }

  function resetAnswerButtons() {
    $all(".qbtn").forEach(btn => {
      btn.disabled = false;
      btn.classList.remove("is-selected");
    });
  }

  async function onAnswerClick(e) {
    const btn = e.target.closest(".qbtn");
    if (!btn) return;
    const answer = btn.dataset.answer;

    $all(".qbtn").forEach(b => b.disabled = true);
    btn.classList.add("is-selected");

    const questionId = state.currentQuestion.question_id;

    try {
      const data = await API.answerQuestion(state.sessionId, questionId, answer);
      state.questionsAsked = (state.questionsAsked || 0) + 1;

      if (data.status === "complete" || data.result) {
        showResult(data.result || data);
        return;
      }

      state.candidateDiseases = data.candidate_diseases || state.candidateDiseases;
      await wait(250);
      showQuestion(data.current_question, data.turn, data.max_turns || state.maxTurns);
    } catch (err) {
      handleAnswerError(err, questionId, answer);
    }
  }

  function handleAnswerError(err, questionId, answer) {
    if (err instanceof A.ApiError) {
      if (err.status === 409 && err.body && err.body.current_question) {
        showQuestion(err.body.current_question, state.turn, state.maxTurns);
        showToast("That question had changed — showing the current one.");
        return;
      }
      if (err.status === 410) {
        showToast("This session expired. Please start a new diagnosis.");
        A.resetSession();
        goToStep("upload");
        return;
      }
      showToast(err.message, { persist: err.status === 503 });
    } else {
      showToast("Couldn't submit that answer. Please try again.");
    }
    resetAnswerButtons();
  }

  const RECS_PREVIEW_LIMIT = 3;
  let recsExpanded = false;

  /* -----------------------------------------------------
     Final result
     ----------------------------------------------------- */
  function renderDiagnosis(result) {
    if (!result) return;

    const plan = (result.diagnosis && result.diagnosis.treatment_plan) 
                 ? result.diagnosis.treatment_plan 
                 : (result.treatment_plan || result);

    state.finalResult = result;
    recsExpanded = false;
    goToStep("result");

    // 1. Hide raw markdown text dump containers
    const rawTextContainers = document.querySelectorAll(
      '.diagnosis-overview-raw, #diag-raw-text, .raw-markdown, #treatment-overview'
    );
    rawTextContainers.forEach(el => {
      if (el.textContent.includes('**') || el.textContent.includes('####')) {
        el.style.display = 'none';
      }
    });

    $("#resultDiseaseName").textContent = result.diagnosed_disease || plan.disease || "Diagnosis";

    const sciEl = $("#resultScientificName");
    if (result.scientific_name) {
      sciEl.textContent = `(${result.scientific_name})`;
      sciEl.hidden = false;
    } else {
      sciEl.hidden = true;
    }

    const pct = Math.round((result.confidence_score || 0) * 100);
    $("#ringPct").textContent = pct + "%";

    $("#statStatus").textContent = result.status || (pct >= 80 ? "Confirmed" : pct >= 55 ? "Likely" : "Uncertain");

    const candidateCount = result.candidate_count || state.candidateDiseases.length || 1;
    $("#statCandidates").textContent = `${candidateCount} Disease${candidateCount === 1 ? "" : "s"}`;

    const askedCount = result.questions_asked ?? state.questionsAsked ?? state.turn ?? 0;
    const maxCount = result.max_turns || state.maxTurns || askedCount;
    $("#statQuestions").textContent = `${askedCount}/${maxCount}`;

    $("#statConflict").textContent = (result.dst_conflict !== undefined && result.dst_conflict !== null)
      ? Number(result.dst_conflict).toFixed(2)
      : "—";

    // Route explanation through formatExplanationContent
    const explanationTarget = document.getElementById('what-this-means-content')
      || document.getElementById('diagnosis-meaning')
      || document.querySelector('.what-this-means-body')
      || document.querySelector('.diagnosis-explanation')
      || $("#resultExplanation");

    if (explanationTarget) {
      const sourceText = result.explanation 
                      || result.meaning 
                      || result.description 
                      || (result.diagnosis && result.diagnosis.explanation) 
                      || '';
                      
      explanationTarget.innerHTML = formatExplanationContent(sourceText);
    }

    // 2. Populate 4 Summary Cards
    const setCardContent = (id, value, fallback) => {
      const el = document.getElementById(id);
      if (!el) return;
      const text = (typeof value === 'string' && value.trim().length > 0) ? value.trim() : fallback;
      el.textContent = text;
    };

    setCardContent(
      'diag-root-cause',
      plan.root_cause,
      'Fungal/bacterial infection spread through moisture and spores.'
    );

    setCardContent(
      'diag-recovery-time',
      plan.recovery_time_days,
      '7–14 days to arrest foliar spread with protective coverage.'
    );

    setCardContent(
      'diag-climate',
      plan.favorable_climate,
      'Warm, humid conditions (20°C–28°C) with persistent leaf wetness.'
    );

    setCardContent(
      'diag-landscape',
      plan.landscape_and_soil,
      'Dense canopies and low-lying areas with poor air drainage.'
    );

    // 3. Defensive List Renderer (Guarantees no single-character iteration)
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

    // 4. Render Actionable Lists
    renderList(
      '#managementList',
      plan.chemical_treatments || plan.management || plan.biological_controls,
      'Apply registered protective fungicides or bactericides following label instructions.'
    );

    renderList(
      '#preventionList',
      plan.cultural_preventive_measures || plan.prevention,
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

    const refsWrap = $("#resultRefsWrap");
    const refsList = $("#resultRefsList");
    refsList.innerHTML = "";
    if (result.references && result.references.length) {
      refsWrap.hidden = false;
      result.references.forEach(url => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = typeof url === 'object' ? (url.url || url.title || String(url)) : String(url);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = typeof url === 'object' ? (url.title || url.url || String(url)) : String(url);
        li.appendChild(a);
        refsList.appendChild(li);
      });
    } else {
      refsWrap.hidden = true;
    }

    $("#followupThread").innerHTML = "";
    $("#followupInput").value = "";
  }

  const showResult = renderDiagnosis;

  function toggleRecommendations() {
    recsExpanded = !recsExpanded;
    $all(".leafList li.is-hidden-extra").forEach(li => {
      li.style.display = recsExpanded ? "flex" : "none";
    });
    $("#toggleRecsBtn").textContent = recsExpanded ? "Show fewer recommendations" : "View all recommendations";
  }

  /* -----------------------------------------------------
     Follow-up Q&A (POST /diagnosis/{id}/followup)
     ----------------------------------------------------- */
  async function onFollowupSubmit(e) {
    e.preventDefault();
    const input = $("#followupInput");
    const question = input.value.trim();
    if (!question) return;

    const sendBtn = e.target.querySelector(".askAi__send");
    sendBtn.disabled = true;
    input.value = "";

    const thread = $("#followupThread");

    const qBubble = document.createElement("div");
    qBubble.className = "bubble bubble--question";
    qBubble.textContent = question;
    thread.appendChild(qBubble);

    const aBubble = document.createElement("div");
    aBubble.className = "bubble bubble--answer is-loading";
    aBubble.textContent = "Thinking…";
    thread.appendChild(aBubble);

    thread.scrollTop = thread.scrollHeight;

    try {
      const data = await API.followup(state.sessionId, question);
      aBubble.textContent = data.answer || data.response || "Follow-up recommendations provided.";
      aBubble.classList.remove("is-loading");
    } catch (err) {
      aBubble.textContent = err instanceof A.ApiError
        ? err.message
        : "Couldn't get an answer right now — please try again.";
      aBubble.classList.remove("is-loading");
    } finally {
      sendBtn.disabled = false;
      thread.scrollTop = thread.scrollHeight;
    }
  }

  /* -----------------------------------------------------
     Session summary (step 5)
     ----------------------------------------------------- */
  function showSummary(result) {
    result = result || state.finalResult;
    if (!result) return;

    goToStep("summary");

    $("#summaryQuestions").textContent = state.questionsAsked || state.turn || 0;
    $("#summaryDiagnosis").textContent = result.diagnosed_disease || "—";
    $("#summaryConfidence").textContent = Math.round((result.confidence_score || 0) * 100) + "%";

    const hasRecs = (result.management_recommendations && result.management_recommendations.length) ||
                    (result.prevention_strategies && result.prevention_strategies.length) ||
                    (result.treatment_plan && result.treatment_plan.chemical_treatments);
    $("#summaryRecommendations").innerHTML = hasRecs
      ? '<span class="statusPill">Generated</span>'
      : '<span class="statusPill">Unavailable</span>';
  }

  function downloadReport() {
    const result = state.finalResult;
    if (!result) return;

    const pct = Math.round((result.confidence_score || 0) * 100);
    const lines = (items) => (items || [])
      .map(i => typeof i === 'object' ? `  - ${i.title || i.description || i.remedy || JSON.stringify(i)}` : `  - ${i}`)
      .join("\n") || "  (none)";

    const plan = result.treatment_plan || {};

    const report = [
      "AGRI-VISION AI — SESSION SUMMARY",
      "=================================",
      "",
      `Session ID:        ${state.sessionId || "—"}`,
      `Questions asked:    ${state.questionsAsked || state.turn || 0}`,
      `Diagnosis:          ${result.diagnosed_disease || plan.disease || "—"}`,
      `Confidence score:   ${pct}%`,
      "",
      "AGRONOMIC CONTEXT PROFILE",
      "--------------------------",
      `Root Cause:          ${plan.root_cause || "—"}`,
      `Recovery Timeline:   ${plan.recovery_time_days || "—"}`,
      `Favorable Climate:   ${plan.favorable_climate || "—"}`,
      `Landscape & Soil:    ${plan.landscape_and_soil || "—"}`,
      "",
      "EXPLANATION",
      "-----------",
      result.explanation || "—",
      "",
      "MANAGEMENT RECOMMENDATIONS",
      "---------------------------",
      lines(plan.chemical_treatments || result.management_recommendations),
      "",
      "PREVENTION STRATEGIES",
      "----------------------",
      lines(plan.cultural_preventive_measures || result.prevention_strategies),
      "",
      "BIOLOGICAL CONTROLS",
      "-------------------",
      lines(plan.biological_controls),
      "",
      "REFERENCES",
      "----------",
      (result.references && result.references.length ? result.references.map(r => typeof r === 'object' ? `  - ${r.title || r.url}` : `  - ${r}`).join("\n") : "  (none)"),
      "",
      `Generated ${new Date().toLocaleString()}`,
    ].join("\n");

    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (result.diagnosed_disease || "diagnosis").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    a.href = url;
    a.download = `agri-vision-report-${safeName}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  document.addEventListener("DOMContentLoaded", init);

  return { showQuestion, showResult, renderDiagnosis, showSummary, formatExplanationContent };
})(window.AgriVision);