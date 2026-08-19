/* =========================================================
   Agri-Vision AI — intake.js
   Step 1: image upload (drag/drop + picker) and validation.
   Step 2: kicks off /diagnosis/start and renders the
   preliminary top-3 prediction read.
   ========================================================= */

AgriVision.Intake = (function (A) {
  const { $, state, CONFIG, API, showToast, formatBytes, goToStep } = A;

  const RANK_COLORS = ["var(--forest)", "#3B6FA0", "var(--amber)"];

  // Holds whatever /start returned, so the "Answer questions" button
  // (rather than a timer) decides when to move on to step 3.
  let pendingAdvance = null;

  function init() {
    const dropzone = $("#dropzone");
    const fileInput = $("#fileInput");
    const chooseFileBtn = $("#chooseFileBtn");
    const replaceFileBtn = $("#replaceFileBtn");
    const analyzeBtn = $("#analyzeBtn");

    chooseFileBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
    replaceFileBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
    dropzone.addEventListener("click", () => { if (!state.imageFile) fileInput.click(); });
    dropzone.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !state.imageFile) { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    ["dragenter", "dragover"].forEach(evt =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); })
    );
    ["dragleave", "drop"].forEach(evt =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); })
    );
    dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    analyzeBtn.addEventListener("click", startAnalysis);
    $("#continueToQuestionsBtn").addEventListener("click", continueToQuestions);

    $("#startNewBtn").addEventListener("click", () => {
      A.resetSession();
      resetUploadUI();
      goToStep("upload");
    });
  }

  function handleFile(file) {
    if (!CONFIG.ACCEPTED_TYPES.includes(file.type)) {
      showToast("Please upload a JPG or PNG image.");
      return;
    }
    if (file.size > CONFIG.MAX_IMAGE_BYTES) {
      showToast("That image is over 5MB — please upload a smaller file.");
      return;
    }

    state.imageFile = file;
    const url = URL.createObjectURL(file);

    $("#uploadEmpty").hidden = true;
    const preview = $("#uploadPreview");
    preview.hidden = false;
    $("#previewImg").src = url;
    $("#previewName").textContent = file.name;
    $("#previewSize").textContent = formatBytes(file.size);

    $("#analyzeBtn").disabled = false;
  }

  function resetUploadUI() {
    $("#uploadEmpty").hidden = false;
    $("#uploadPreview").hidden = true;
    $("#analyzeBtn").disabled = true;
    $("#fileInput").value = "";
    $("#predictionsList").querySelectorAll(".pred-row").forEach(el => el.remove());
    $("#analyzeProgressFill").style.width = "0%";
    $("#analyzeProgressPct").textContent = "0%";
    $("#continuePrompt").hidden = true;
    pendingAdvance = null;
  }

  async function startAnalysis() {
    if (!state.imageFile) return;

    goToStep("analyzing");
    $("#analyzeImg").src = $("#previewImg").src;
    $("#analyzeStatusText").textContent = "Analyzing image…";
    $("#analyzeProgressFill").style.width = "0%";
    $("#analyzeProgressPct").textContent = "0%";
    $("#predictionsList").querySelectorAll(".pred-row").forEach(el => el.remove());
    $("#continuePrompt").hidden = true;
    pendingAdvance = null;

    const progressDone = simulateProgress();

    try {
      const data = await API.startDiagnosis(state.imageFile);

      state.sessionId = data.session_id;
      state.top3 = data.top3_predictions || [];
      state.candidateDiseases = data.candidate_diseases || [];
      state.currentQuestion = data.current_question || null;
      state.turn = data.turn || 1;
      state.maxTurns = data.max_turns || 5;
      A.updateSessionBadge();
      sessionStorage.setItem("agrivision_session_id", state.sessionId);

      await progressDone; // let the visual progress finish even if the API was fast
      renderPredictions(state.top3);

      // Hold here — the user taps "Answer questions" to move on, rather
      // than auto-advancing as soon as the prediction is in.
      pendingAdvance = data;
      await wait(400);
      $("#continuePrompt").hidden = false;
    } catch (err) {
      await progressDone;
      handleStartError(err);
    }
  }

  function continueToQuestions() {
    if (!pendingAdvance) return;
    const data = pendingAdvance;
    pendingAdvance = null;
    $("#continuePrompt").hidden = true;

    if (data.status === "complete") {
      A.Results.showResult(data.result);
    } else {
      A.Results.showQuestion(state.currentQuestion, state.turn, state.maxTurns);
    }
  }

  function handleStartError(err) {
    if (err instanceof A.ApiError) {
      showToast(err.message, { persist: err.status === 503 });
    } else {
      showToast("Something went wrong analyzing that image. Please try again.");
    }
    goToStep("upload");
  }

  function simulateProgress() {
    return new Promise((resolve) => {
      const fill = $("#analyzeProgressFill");
      const pct = $("#analyzeProgressPct");
      let value = 0;
      const timer = setInterval(() => {
        value += Math.random() * 14 + 6;
        if (value >= 96) {
          value = 96;
          clearInterval(timer);
          resolve();
        }
        fill.style.width = value.toFixed(0) + "%";
        pct.textContent = value.toFixed(0) + "%";
      }, 220);
    }).then(() => {
      $("#analyzeProgressFill").style.width = "100%";
      $("#analyzeProgressPct").textContent = "100%";
      $("#analyzeStatusText").textContent = "Analysis complete";
    });
  }

  function renderPredictions(top3) {
    const list = $("#predictionsList");
    top3.forEach((pred, i) => {
      const row = document.createElement("div");
      row.className = "pred-row";
      row.style.animationDelay = `${i * 120}ms`;
      const pct = Math.round(pred.probability * 100);
      row.innerHTML = `
        <span class="pred-row__rank" style="background:${RANK_COLORS[i] || "var(--ink-faint)"}">${i + 1}</span>
        <span class="pred-row__body">
          <span class="pred-row__name">${escapeHtml(pred.disease)}</span>
          <span class="pred-row__track"><span class="pred-row__fill" style="background:${RANK_COLORS[i] || "var(--ink-faint)"}"></span></span>
        </span>
        <span class="pred-row__pct mono">${pct}%</span>
      `;
      list.appendChild(row);
      requestAnimationFrame(() => {
        setTimeout(() => {
          row.querySelector(".pred-row__fill").style.width = pct + "%";
        }, 60 + i * 100);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  document.addEventListener("DOMContentLoaded", init);

  return { handleFile };
})(window.AgriVision);