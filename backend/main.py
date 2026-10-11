from pathlib import Path
from io import BytesIO
import json
import os
import zipfile
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher
from starlette.concurrency import run_in_threadpool

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
MODEL_NAME = os.getenv("OLLAMA_MODEL", "granite4.1:3b")
# Older Ollama versions default to a small context window and silently cut
# long prompts, so request enough room for a full section plus its reply.
CONTEXT_TOKENS = 16_384
MAX_INPUT_BYTES = 10_000_000
MAX_CHUNK_CHARS = 24_000
SUPPORTED_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".html", ".htm", ".css", ".js", ".jsx",
    ".ts", ".tsx", ".py", ".json", ".csv", ".xml", ".yaml", ".yml",
    ".log", ".sql", ".sh", ".bat", ".ps1", ".pdf", ".docx",
}


def ask_granite(prompt: str, temperature: float | None = None, json_mode: bool = False) -> str:
    try:
        payload = {
            "model": MODEL_NAME,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"num_ctx": CONTEXT_TOKENS},
        }
        if temperature is not None:
            payload["options"]["temperature"] = temperature
        if json_mode:
            payload["format"] = "json"
        response = requests.post(
            OLLAMA_URL,
            json=payload,
            timeout=300,
        )
        if response.status_code == 404:
            raise HTTPException(
                status_code=503,
                detail=f"The model {MODEL_NAME} is not installed. Run: ollama pull {MODEL_NAME}",
            )
        response.raise_for_status()
        return response.json()["message"]["content"]
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not reach Ollama. Make sure Ollama is running.",
        ) from exc


def make_analysis_prompt(text: str, mode: str, section_index: int, section_total: int) -> str:
    if mode == "proofread":
        focus = """Proofread the text. Identify spelling, grammar, punctuation,
formatting, and consistency issues. Separate definite errors from optional
style suggestions. Give corrected examples and a concise explanation."""
    elif mode == "code":
        focus = """Explain the code in beginner-friendly language. Identify its
language when possible, describe its purpose and flow, explain important
constructs, and point out likely bugs or risks without claiming to execute it.
Suggest corrections only when you can preserve the intended behavior."""
    else:
        focus = """Identify what kind of input this is, then explain its meaning
or purpose clearly. For prose, explain the main idea; for a word or symbol,
explain its likely meaning; for code, explain what it appears to do. Also
review spelling, grammar, punctuation, and formatting where applicable."""

    return f"""You are a careful text explanation and proofreading assistant.
This is section {section_index} of {section_total} from the user's input.

Task mode: {mode}
{focus}

For prose, list all clear spelling corrections as original → suggested spelling.
Do not replace a valid word with a different valid word or synonym. Preserve
the user's meaning, names, technical terms, and code behavior. If uncertain,
leave the original unchanged. Do not claim factual verification without evidence.

Return a JSON object with exactly these string fields:
{{"analysis": "Your explanation and findings", "corrected_text": "This section with only clear corrections applied"}}
The corrected_text must include the complete section, preserving its line breaks.
If no correction is needed, copy the section exactly. Do not wrap the JSON in
Markdown fences.

User input section:
{text}
"""


def split_into_chunks(text: str) -> list[str]:
    """Split long input at nearby line breaks or spaces without dropping content."""
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + MAX_CHUNK_CHARS, len(text))
        if end < len(text):
            newline = text.rfind("\n", start, end)
            whitespace = text.rfind(" ", start, end)
            boundary = max(newline, whitespace)
            if boundary > start + MAX_CHUNK_CHARS // 2:
                end = boundary + 1
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk)
        start = end
    return chunks


def extract_upload_text(filename: str, contents: bytes) -> str:
    extension = Path(filename).suffix.lower()
    if extension == ".docx":
        try:
            with zipfile.ZipFile(BytesIO(contents)) as archive:
                document_xml = archive.read("word/document.xml")
            root = ET.fromstring(document_xml)
            word_ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            paragraphs = []
            for paragraph in root.iter(f"{word_ns}p"):
                parts = [node.text or "" for node in paragraph.iter(f"{word_ns}t")]
                paragraphs.append("".join(parts))
            return "\n".join(paragraphs)
        except (KeyError, zipfile.BadZipFile, ET.ParseError) as exc:
            raise HTTPException(status_code=400, detail="Could not read that Word document.") from exc

    if extension == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise HTTPException(
                status_code=503,
                detail="PDF support needs pypdf. Install the project requirements and restart the server.",
            ) from exc
        try:
            reader = PdfReader(BytesIO(contents))
            extracted = "\n\n".join(page.extract_text() or "" for page in reader.pages)
            if not extracted.strip():
                raise HTTPException(
                    status_code=400,
                    detail="No selectable text was found in this PDF. Scanned pages need OCR before they can be analyzed.",
                )
            return extracted
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Could not extract text from that PDF.") from exc

    try:
        return contents.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="The file must contain UTF-8 text.",
        ) from exc


@app.post("/analyze")
async def analyze(
    text: str = Form(""),
    file: UploadFile | None = File(None),
    mode: str = Form("explain"),
):
    if mode not in {"explain", "proofread", "code"}:
        raise HTTPException(status_code=400, detail="Choose a valid analysis mode.")

    if file is not None:
        extension = Path(file.filename or "").suffix.lower()
        if extension not in SUPPORTED_TEXT_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="Choose a supported plain-text or code file, or paste your text.",
            )

        contents = await file.read(MAX_INPUT_BYTES + 1)
        if len(contents) > MAX_INPUT_BYTES:
            raise HTTPException(status_code=413, detail="This file is too large to process in one session.")

        text = extract_upload_text(file.filename or "", contents)

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Paste text or choose a supported text, code, PDF, or DOCX file.")

    if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail="This text is too large to process in one session.")

    chunks = split_into_chunks(text)

    async def generate_progress():
        analysis_parts = []
        corrected_parts = []
        changed_ranges = []
        corrected_offset = 0
        for index, chunk in enumerate(chunks, start=1):
            yield json.dumps({"type": "progress", "current": index - 1, "total": len(chunks), "working": index}) + "\n"
            try:
                raw = await run_in_threadpool(
                    ask_granite,
                    make_analysis_prompt(chunk, mode, index, len(chunks)),
                    temperature=0,
                    json_mode=True,
                )
                try:
                    result = json.loads(raw)
                except json.JSONDecodeError:
                    result = {"analysis": raw, "corrected_text": chunk}
                section_analysis = str(result.get("analysis", "")).strip() or "No explanation was returned for this section."
                corrected = result.get("corrected_text", chunk)
                if not isinstance(corrected, str):
                    corrected = chunk
                analysis_parts.append(f"SECTION {index} OF {len(chunks)}\n{section_analysis}")
                matcher = SequenceMatcher(None, chunk, corrected)
                for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
                    if tag != "equal" and j2 > j1:
                        changed_ranges.append([corrected_offset + j1, corrected_offset + j2])
                corrected_parts.append(corrected)
                corrected_offset += len(corrected)
            except HTTPException as exc:
                yield json.dumps({"type": "error", "detail": exc.detail}) + "\n"
                return
            yield json.dumps({"type": "progress", "current": index, "total": len(chunks), "working": None}) + "\n"

        analysis = "\n\n".join(analysis_parts)
        if len(chunks) > 1:
            analysis = f"This input was analyzed in {len(chunks)} sections.\n\n" + analysis
        yield json.dumps({
            "type": "complete",
            "original_text": text,
            "analysis": analysis,
            "corrected_text": "".join(corrected_parts),
            "changes": changed_ranges,
            "sections": len(chunks),
        }, ensure_ascii=False) + "\n"

    return StreamingResponse(
        generate_progress(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class QuestionRequest(BaseModel):
    text: str
    question: str


class SpellcheckRequest(BaseModel):
    text: str


@app.post("/spellcheck")
def spellcheck(request: SpellcheckRequest):
    text = request.text.strip()
    if not text:
        return {"suggestions": ""}

    # Keep live checks quick; the full document is checked during Analyze.
    excerpt = text[-4_000:]
    prompt = f"""Review the text for all likely spelling errors and obvious punctuation
issues. Scan every word from left to right and report all issues; do not stop
after the first. For spelling, ignore names, code, valid dictionary words,
and valid technical terms. Never replace a correctly spelled word with a
synonym or a different valid word; "clod" is a valid English word. If unsure,
leave the word alone.

Also check clear punctuation problems, including unmatched quotation marks,
repeated punctuation, or missing end punctuation on a complete sentence. Do
not guess about a sentence that appears unfinished while the user is typing.

Return one separate line for each issue, labeled "Spelling" or "Punctuation".
For spelling, use: Spelling: original → suggested correction
For punctuation, briefly identify the issue and show a corrected version.
Example: for "excting is the oen feling." report all three spelling fixes:
excting → exciting; oen → one; feling → feeling.
If there are no clear issues, reply: No likely spelling or punctuation issues found.
Do not add grammar or style suggestions in this live check.

Text:
{excerpt}
"""
    return {"suggestions": ask_granite(prompt, temperature=0)}


@app.post("/ask")
def ask_question(request: QuestionRequest):
    text = request.text.strip()
    question = request.question.strip()

    if not text or not question:
        raise HTTPException(status_code=400, detail="Text and question are required.")

    chunks = split_into_chunks(text)
    if len(chunks) > 1:
        answers = []
        for index, chunk in enumerate(chunks, start=1):
            prompt = f"""Answer the user's question using only this section of a longer input.
If the section does not contain enough information, say so briefly.

Section {index} of {len(chunks)}:
{chunk}

Question:
{question}
"""
            answers.append(f"SECTION {index}\n{ask_granite(prompt)}")
        return {"answer": "\n\n".join(answers)}

    prompt = f"""Answer the user's question about the supplied input.
Explain clearly. Base your answer on the input first. If the question needs
information the input does not contain, you may use general knowledge, but
say briefly that this part goes beyond the input.

Supplied input:
{text}

User's question:
{question}
"""
    return {"answer": ask_granite(prompt)}


frontend_folder = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=frontend_folder, html=True), name="frontend")
