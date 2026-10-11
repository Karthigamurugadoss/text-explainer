const inputText = document.getElementById("inputText");
const fileInput = document.getElementById("fileInput");
const fileLabel = document.getElementById("fileLabel");
const dropZone = document.getElementById("dropZone");
const charCount = document.getElementById("charCount");
const spellStatus = document.getElementById("spellStatus");
const analyzeButton = document.getElementById("analyzeButton");
const clearButton = document.getElementById("clearButton");
const sampleButton = document.getElementById("sampleButton");
const status = document.getElementById("status");
const analysisSection = document.getElementById("analysisSection");
const analysisResult = document.getElementById("analysisResult");
const analysisMode = document.getElementById("analysisMode");
const progressBar = document.getElementById("progressBar");
const correctionSection = document.getElementById("correctionSection");
const originalVersion = document.getElementById("originalVersion");
const correctedPreview = document.getElementById("correctedPreview");
const correctedEditor = document.getElementById("correctedEditor");
const editDraftButton = document.getElementById("editDraftButton");
const copyCorrectedButton = document.getElementById("copyCorrectedButton");
const applyCorrectedButton = document.getElementById("applyCorrectedButton");
const copyButton = document.getElementById("copyButton");
const downloadButton = document.getElementById("downloadButton");
const questionInput = document.getElementById("questionInput");
const askButton = document.getElementById("askButton");
const answerResult = document.getElementById("answerResult");

let currentText = "";
let currentCorrectedText = "";
let correctedRanges = [];
let spellcheckTimer;
let spellcheckRequestId = 0;
const supportedExtensions = new Set([
  "txt", "md", "markdown", "html", "htm", "css", "js", "jsx", "ts", "tsx",
  "py", "json", "csv", "xml", "yaml", "yml", "log", "sql", "sh", "bat", "ps1", "pdf", "docx"
]);
const textExtensions = new Set([
  "txt", "md", "markdown", "html", "htm", "css", "js", "jsx", "ts", "tsx",
  "py", "json", "csv", "xml", "yaml", "yml", "log", "sql", "sh", "bat", "ps1"
]);
const defaultFileLabel = "Drag a file here · TXT, code, PDF, or DOCX";

function updateCount() {
  const count = inputText.value.length;
  charCount.textContent = `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function scheduleSpellcheck() {
  clearTimeout(spellcheckTimer);
  const text = inputText.value.trim();
  const requestId = ++spellcheckRequestId;

  if (!text) {
    spellStatus.textContent = "Live spelling and punctuation check appears after you pause typing.";
    spellStatus.className = "spell-status";
    return;
  }

  spellStatus.textContent = "Checking spelling and punctuation when you pause…";
  spellStatus.className = "spell-status is-checking";
  spellcheckTimer = setTimeout(async () => {
    spellStatus.textContent = text.length > 4000
      ? "Granite is checking recent text for spelling and punctuation…"
      : "Granite is checking spelling and punctuation…";
    try {
      const response = await fetch("/spellcheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await response.json();
      if (requestId !== spellcheckRequestId) return;
      if (!response.ok) throw new Error(data.detail || "Spellcheck failed.");
      spellStatus.textContent = text.length > 4000
        ? `${data.suggestions} (Live check covers recent text; Analyze checks the full input.)`
        : data.suggestions;
      spellStatus.className = `spell-status${/no likely spelling (or punctuation )?issues found/i.test(data.suggestions) ? "" : " has-suggestions"}`;
    } catch (error) {
      if (requestId !== spellcheckRequestId) return;
      spellStatus.textContent = `Live spelling check unavailable: ${error.message}`;
      spellStatus.className = "spell-status";
    }
  }, 1400);
}

function acceptFile(file) {
  if (!file) return;
  const extension = file.name.toLowerCase().split(".").pop();
  if (!supportedExtensions.has(extension)) {
    fileInput.value = "";
    fileLabel.textContent = defaultFileLabel;
    setStatus("Choose a supported text, code, PDF, or DOCX file.", true);
    return;
  }
  if (file.size > 10_000_000) {
    fileInput.value = "";
    fileLabel.textContent = defaultFileLabel;
    setStatus("That file is too large to process.", true);
    return;
  }
  fileLabel.textContent = file.name;
  if (!textExtensions.has(extension)) {
    inputText.value = "";
    updateCount();
    spellStatus.textContent = "File text will be extracted before analysis.";
    setStatus("File ready. Text will be extracted on this computer.");
    return;
  }
  file.text().then((text) => {
    inputText.value = text;
    updateCount();
    scheduleSpellcheck();
    setStatus("File ready to analyze.");
  }).catch(() => setStatus("Could not read that file. Try a UTF-8 text or code file.", true));
}

fileInput.addEventListener("change", () => acceptFile(fileInput.files[0]));
inputText.addEventListener("input", () => {
  updateCount();
  scheduleSpellcheck();
  if (fileInput.files.length) {
    fileInput.value = "";
    fileLabel.textContent = defaultFileLabel;
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => acceptFile(event.dataTransfer.files[0]));

clearButton.addEventListener("click", () => {
  inputText.value = "";
  fileInput.value = "";
  fileLabel.textContent = defaultFileLabel;
  currentText = "";
  analysisResult.textContent = "";
  answerResult.textContent = "";
  answerResult.hidden = true;
  questionInput.value = "";
  analysisSection.hidden = true;
  progressBar.hidden = true;
  clearTimeout(spellcheckTimer);
  spellcheckRequestId++;
  spellStatus.textContent = "Live spelling and punctuation check appears after you pause typing.";
  spellStatus.className = "spell-status";
  updateCount();
  setStatus("Your text stays on this computer.");
  inputText.focus();
});

sampleButton.addEventListener("click", () => {
  inputText.value = "The phrase ‘break the ice’ means to make people feel more comfortable at the start of a conversation.";
  fileInput.value = "";
  fileLabel.textContent = defaultFileLabel;
  updateCount();
  scheduleSpellcheck();
  setStatus(`Sample added. Click ${analyzeButton.textContent.trim()} when ready.`);
  inputText.focus();
});

function renderCorrectedPreview(text, ranges) {
  correctedPreview.replaceChildren();
  let cursor = 0;
  for (const range of ranges || []) {
    const start = Math.max(cursor, Math.min(text.length, Number(range[0])));
    const end = Math.max(start, Math.min(text.length, Number(range[1])));
    if (start > cursor) correctedPreview.append(document.createTextNode(text.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      correctedPreview.append(mark);
    }
    cursor = end;
  }
  correctedPreview.append(document.createTextNode(text.slice(cursor)));
}

async function parseAnalysisStream(response, onProgress) {
  if (!response.ok) {
    let detail = "The analysis request failed.";
    try { detail = (await response.json()).detail || detail; } catch { /* keep default message */ }
    throw new Error(detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  const handleLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.detail || "The analysis request failed.");
    if (event.type === "progress") onProgress(event);
    if (event.type === "complete") completed = event;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
    if (done) break;
  }
  if (buffer.trim()) handleLine(buffer);
  if (!completed) throw new Error("The server ended before returning the analysis.");
  return completed;
}

analyzeButton.addEventListener("click", async () => {
  const text = inputText.value.trim();
  const file = fileInput.files[0];
  if (!text && !file) {
    setStatus("Paste some text or choose a supported file first.", true);
    inputText.focus();
    return;
  }

  const modeLabels = { explain: "Analyze and explain", proofread: "Proofread text", code: "Explain code" };
  const formData = new FormData();
  formData.append("text", text);
  formData.append("mode", analysisMode.value);
  if (file) formData.append("file", file);
  analyzeButton.disabled = true;
  analyzeButton.querySelector("span").textContent = "Starting…";
  setStatus("Preparing your input…");
  progressBar.value = 0;
  progressBar.hidden = false;
  analysisSection.hidden = true;
  correctionSection.hidden = true;
  answerResult.hidden = true;
  clearTimeout(spellcheckTimer);
  spellcheckRequestId++;
  spellStatus.textContent = "Analysis includes proofreading and a corrected draft.";
  spellStatus.className = "spell-status";

  try {
    const response = await fetch("/analyze", { method: "POST", body: formData });
    const data = await parseAnalysisStream(response, (event) => {
      const percent = event.total ? Math.round((event.current / event.total) * 100) : 0;
      progressBar.value = percent;
      if (event.working) {
        setStatus(`Analyzing section ${event.working} of ${event.total}…`);
        analyzeButton.querySelector("span").textContent = `Section ${event.working}/${event.total}`;
      } else {
        setStatus(`Completed section ${event.current} of ${event.total}.`);
      }
    });

    currentText = data.original_text ?? text;
    currentCorrectedText = data.corrected_text ?? currentText;
    correctedRanges = data.changes || [];
    analysisResult.textContent = data.analysis;
    originalVersion.textContent = currentText;
    renderCorrectedPreview(currentCorrectedText, correctedRanges);
    correctedEditor.value = currentCorrectedText;
    correctedEditor.hidden = true;
    correctedPreview.hidden = false;
    editDraftButton.textContent = "Edit draft";
    correctionSection.hidden = false;
    analysisSection.hidden = false;
    progressBar.value = 100;
    setStatus(`Analysis complete${data.sections > 1 ? ` · ${data.sections} sections` : ""}.`);
    analysisSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    progressBar.hidden = true;
    setStatus(`Could not analyze the input: ${error.message}`, true);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.querySelector("span").textContent = modeLabels[analysisMode.value] || "Analyze and explain";
  }
});

analysisMode.addEventListener("change", () => {
  const labels = { explain: "Analyze and explain", proofread: "Proofread text", code: "Explain code" };
  analyzeButton.querySelector("span").textContent = labels[analysisMode.value];
});

editDraftButton.addEventListener("click", () => {
  const openingEditor = correctedEditor.hidden;
  correctedEditor.hidden = !openingEditor;
  correctedPreview.hidden = openingEditor;
  editDraftButton.textContent = openingEditor ? "Show highlighted preview" : "Edit draft";
});

copyCorrectedButton.addEventListener("click", async () => {
  const draft = correctedEditor.hidden ? currentCorrectedText : correctedEditor.value;
  try {
    await navigator.clipboard.writeText(draft);
    copyCorrectedButton.textContent = "Copied";
    setTimeout(() => { copyCorrectedButton.textContent = "Copy corrected text"; }, 1400);
  } catch {
    setStatus("Clipboard access was blocked by the browser.", true);
  }
});

applyCorrectedButton.addEventListener("click", () => {
  const draft = correctedEditor.hidden ? currentCorrectedText : correctedEditor.value;
  inputText.value = draft;
  currentText = draft;
  currentCorrectedText = draft;
  fileInput.value = "";
  fileLabel.textContent = defaultFileLabel;
  updateCount();
  setStatus("Corrected draft placed in the text box. Your original was kept until this choice.");
  inputText.focus();
  inputText.scrollIntoView({ behavior: "smooth", block: "center" });
});

async function askQuestion() {
  if (askButton.disabled) return;
  const question = questionInput.value.trim();
  if (!currentText) {
    setStatus("Analyze your input before asking a question.", true);
    return;
  }
  if (!question) {
    answerResult.textContent = "Type a question first.";
    answerResult.hidden = false;
    questionInput.focus();
    return;
  }

  askButton.disabled = true;
  answerResult.hidden = false;
  answerResult.textContent = "Granite is preparing an answer…";
  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: currentText, question })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "The question request failed.");
    answerResult.textContent = data.answer;
  } catch (error) {
    answerResult.textContent = `Could not get an answer: ${error.message}`;
  } finally {
    askButton.disabled = false;
  }
}

askButton.addEventListener("click", askQuestion);
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") askQuestion();
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(analysisResult.textContent);
    copyButton.textContent = "Copied";
    setTimeout(() => { copyButton.textContent = "Copy"; }, 1400);
  } catch {
    setStatus("Clipboard access was blocked by the browser.", true);
  }
});

downloadButton.addEventListener("click", () => {
  const report = `Text Explainer — IBM Granite 4.1 3B\n\nInput:\n${currentText}\n\nExplanation and analysis:\n${analysisResult.textContent}\n`;
  const url = URL.createObjectURL(new Blob([report], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "text-explainer-analysis.txt";
  link.click();
  URL.revokeObjectURL(url);
});

updateCount();
