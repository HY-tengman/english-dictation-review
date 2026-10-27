const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const { execFile } = require("node:child_process");

const root = __dirname;
const dataDir = path.join(root, "data");
const ttsCacheDir = path.join(dataDir, "tts-cache");
const libraryFile = path.join(dataDir, "library.json");

function loadLocalEnv() {
  const envFile = path.join(dataDir, "tts.env");
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  });
}

loadLocalEnv();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const azureTtsVoices = new Map([
  ["en-US-JennyNeural", { gender: "女声", label: "Jenny 在线自然女声" }],
  ["en-US-DavisNeural", { gender: "男声", label: "Davis 在线自然男声" }],
  ["en-US-AriaNeural", { gender: "女声", label: "Aria 在线自然女声" }],
  ["en-US-GuyNeural", { gender: "男声", label: "Guy 在线自然男声" }],
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
};

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(libraryFile)) {
    fs.writeFileSync(libraryFile, "[]\n", "utf8");
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 35 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sendAudioFile(response, filePath) {
  response.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(response);
}

function getAzureRate(rate) {
  const numericRate = Number(rate || 1);
  if (!Number.isFinite(numericRate)) return "+0%";
  const percent = Math.max(-50, Math.min(50, Math.round((numericRate - 1) * 100)));
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

async function synthesizeWithAzure({ text, voiceName, rate }) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    const error = new Error("Azure Speech is not configured");
    error.statusCode = 503;
    throw error;
  }

  const ssml = `
<speak version="1.0" xml:lang="en-US">
  <voice xml:lang="en-US" xml:gender="${azureTtsVoices.get(voiceName)?.gender === "男声" ? "Male" : "Female"}" name="${escapeXml(voiceName)}">
    <prosody rate="${getAzureRate(rate)}">${escapeXml(text)}</prosody>
  </voice>
</speak>`.trim();

  const result = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "english-dictation-review",
    },
    body: ssml,
  });

  if (!result.ok) {
    const detail = await result.text().catch(() => "");
    const error = new Error(`Azure Speech failed: ${result.status} ${detail.slice(0, 180)}`);
    error.statusCode = 502;
    throw error;
  }

  return Buffer.from(await result.arrayBuffer());
}

function getAudioExtension(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("mp4")) return "mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg")) return "ogg";
  return "webm";
}

function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function getLocalWhisperConfig() {
  const binaryPath = process.env.LOCAL_WHISPER_BIN || path.join(root, "tools", "whisper.cpp", "build", "bin", "whisper-cli");
  const modelPath = process.env.LOCAL_WHISPER_MODEL || path.join(root, "tools", "whisper.cpp", "models", "ggml-base.en.bin");
  const configured = fileExists(binaryPath) && fileExists(modelPath);
  return {
    provider: "local-whisper",
    configured,
    binaryPath,
    modelPath,
    modelName: path.basename(modelPath),
  };
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: options.timeout || 120000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      cwd: options.cwd || root,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function transcribeWithLocalWhisper({ audioBuffer, mimeType }) {
  const whisper = getLocalWhisperConfig();
  if (!whisper.configured) {
    const missing = [
      fileExists(whisper.binaryPath) ? "" : "Whisper 程序",
      fileExists(whisper.modelPath) ? "" : "Whisper 模型",
    ].filter(Boolean).join("、");
    const error = new Error(`本地 Whisper 未就绪：缺少 ${missing || "必要文件"}`);
    error.statusCode = 503;
    throw error;
  }

  if (!String(mimeType || "").toLowerCase().includes("wav")) {
    const error = new Error("本地 Whisper 当前需要 WAV 录音，请刷新页面后重试。");
    error.statusCode = 400;
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-whisper-"));
  const inputFile = path.join(tempDir, "recording.wav");
  const outputBase = path.join(tempDir, "transcript");
  const outputFile = `${outputBase}.txt`;

  try {
    fs.writeFileSync(inputFile, audioBuffer);
    await runFile(whisper.binaryPath, [
      "-m", whisper.modelPath,
      "-f", inputFile,
      "-l", "en",
      "-nt",
      "-otxt",
      "-of", outputBase,
    ], {
      timeout: Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 120000),
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [
          path.dirname(whisper.binaryPath),
          process.env.DYLD_LIBRARY_PATH || "",
        ].filter(Boolean).join(":"),
      },
    });
    return fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeMultipartBody(fields, file) {
  const boundary = `----english-dictation-${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  Object.entries(fields).forEach(([name, value]) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${value}\r\n`));
  });
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`));
  chunks.push(Buffer.from(`Content-Type: ${file.mimeType}\r\n\r\n`));
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, buffer: Buffer.concat(chunks) };
}

function parseHttpResponse(buffer) {
  const marker = Buffer.from("\r\n\r\n");
  const headerEnd = buffer.indexOf(marker);
  if (headerEnd < 0) throw new Error("Invalid HTTP response");
  const headerText = buffer.slice(0, headerEnd).toString("utf8");
  const body = buffer.slice(headerEnd + marker.length);
  const statusCode = Number((headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1] || 0);
  return { statusCode, body };
}

function connectTlsViaProxy(target, proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const socket = net.connect(Number(proxy.port || 8080), proxy.hostname);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Proxy connection timed out"));
    }, 20000);

    socket.once("connect", () => {
      socket.write([
        `CONNECT ${target.hostname}:443 HTTP/1.1`,
        `Host: ${target.hostname}:443`,
        "Proxy-Connection: Keep-Alive",
        "\r\n",
      ].join("\r\n"));
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    let responseBuffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd < 0) return;
      const response = responseBuffer.slice(0, headerEnd).toString("utf8");
      if (!/^HTTP\/\d(?:\.\d)?\s+200\b/.test(response)) {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${response.split("\r\n")[0] || "unknown"}`));
        return;
      }
      clearTimeout(timeout);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      const secureSocket = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ["http/1.1"],
      });
      secureSocket.once("secureConnect", () => resolve(secureSocket));
      secureSocket.once("error", reject);
    });
  });
}

function connectTlsDirect(target) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, target.hostname, {
      servername: target.hostname,
      ALPNProtocols: ["http/1.1"],
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("OpenAI connection timed out"));
    }, 20000);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function postBuffer(url, headers, bodyBuffer) {
  const target = new URL(url);
  const proxyUrl = process.env.OPENAI_PROXY_URL || "";
  const socket = proxyUrl ? await connectTlsViaProxy(target, proxyUrl) : await connectTlsDirect(target);

  return new Promise((resolve, reject) => {
    const responseChunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("OpenAI response timed out"));
    }, 60000);
    socket.on("data", chunk => responseChunks.push(chunk));
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      try {
        resolve(parseHttpResponse(Buffer.concat(responseChunks)));
      } catch (error) {
        reject(error);
      }
    });
    socket.write([
      `POST ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.hostname}`,
      "Connection: close",
      `Content-Length: ${bodyBuffer.length}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "\r\n",
    ].join("\r\n"));
    socket.write(bodyBuffer);
  });
}

async function transcribeWithOpenAI({ audioBuffer, mimeType, prompt }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const error = new Error("OpenAI transcription is not configured");
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
  const extension = getAudioExtension(mimeType);
  const multipart = makeMultipartBody({
    model,
    language: "en",
    response_format: "json",
    prompt: prompt || "Transcribe clear American English dictation. Preserve English words, contractions, punctuation, and acronyms like HR.",
  }, {
    name: "file",
    filename: `recording.${extension}`,
    mimeType: mimeType || "audio/webm",
    buffer: audioBuffer,
  });

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  let result;
  try {
    result = await postBuffer(`${baseUrl}/audio/transcriptions`, {
      "Authorization": `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      "Accept": "application/json",
    }, multipart.buffer);
  } catch (cause) {
    const detail = cause?.code || cause?.message || "unknown";
    const error = new Error(`Cannot connect to OpenAI transcription API (${detail}). Check network, proxy, or OPENAI_BASE_URL.`);
    error.statusCode = 502;
    error.cause = cause;
    throw error;
  }

  const responseText = result.body.toString("utf8");
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const error = new Error(`OpenAI transcription failed: ${result.statusCode} ${responseText.slice(0, 180)}`);
    error.statusCode = result.statusCode >= 500 ? 502 : result.statusCode;
    throw error;
  }

  try {
    const payload = JSON.parse(responseText);
    return payload.text || "";
  } catch {
    return responseText.trim();
  }
}

function saveItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }
  ensureDataFile();
  const tempFile = `${libraryFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, libraryFile);
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/english-dictation-review.html") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const filePath = path.join(root, "english-dictation-review.html");
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
}

async function handleApi(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (requestUrl.pathname === "/api/tts/status") {
    sendJson(response, 200, {
      provider: "azure",
      configured: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
      voices: Array.from(azureTtsVoices, ([name, info]) => ({ name, ...info, lang: "en-US" })),
    });
    return true;
  }

  if (requestUrl.pathname === "/api/tts") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return true;
    }

    const text = (requestUrl.searchParams.get("text") || "").trim().slice(0, 500);
    const voiceName = requestUrl.searchParams.get("voice") || "en-US-JennyNeural";
    const rate = requestUrl.searchParams.get("rate") || "1";
    if (!text) {
      sendJson(response, 400, { ok: false, error: "Missing text" });
      return true;
    }
    if (!azureTtsVoices.has(voiceName)) {
      sendJson(response, 400, { ok: false, error: "Unsupported voice" });
      return true;
    }

    fs.mkdirSync(ttsCacheDir, { recursive: true });
    const cacheKey = crypto
      .createHash("sha256")
      .update(JSON.stringify({ provider: "azure", voiceName, rate, text }))
      .digest("hex");
    const cacheFile = path.join(ttsCacheDir, `${cacheKey}.mp3`);
    if (fs.existsSync(cacheFile)) {
      sendAudioFile(response, cacheFile);
      return true;
    }

    const audio = await synthesizeWithAzure({ text, voiceName, rate });
    fs.writeFileSync(cacheFile, audio);
    sendAudioFile(response, cacheFile);
    return true;
  }

  if (requestUrl.pathname === "/api/transcribe/status") {
    const localWhisper = getLocalWhisperConfig();
    sendJson(response, 200, {
      provider: localWhisper.configured ? "local-whisper" : "openai",
      configured: localWhisper.configured || Boolean(process.env.OPENAI_API_KEY),
      localWhisper: {
        configured: localWhisper.configured,
        model: localWhisper.modelName,
      },
      openai: {
        configured: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe",
      },
    });
    return true;
  }

  if (requestUrl.pathname === "/api/transcribe") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end("Method not allowed");
      return true;
    }

    const payload = await readJsonBody(request);
    const rawAudio = payload.audioBase64 || "";
    const audioBase64 = rawAudio.includes(",") ? rawAudio.split(",").pop() : rawAudio;
    if (!audioBase64) {
      sendJson(response, 400, { ok: false, error: "Missing audio" });
      return true;
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (!audioBuffer.length) {
      sendJson(response, 400, { ok: false, error: "Empty audio" });
      return true;
    }

    const localWhisper = getLocalWhisperConfig();
    const text = localWhisper.configured
      ? await transcribeWithLocalWhisper({
        audioBuffer,
        mimeType: payload.mimeType || "audio/wav",
      })
      : await transcribeWithOpenAI({
        audioBuffer,
        mimeType: payload.mimeType || "audio/webm",
        prompt: payload.prompt,
      });
    sendJson(response, 200, { ok: true, text });
    return true;
  }

  if (requestUrl.pathname !== "/api/items") return false;

  ensureDataFile();
  if (request.method === "GET") {
    const items = JSON.parse(fs.readFileSync(libraryFile, "utf8") || "[]");
    sendJson(response, 200, {
      items,
      count: items.length,
      updatedAt: fs.statSync(libraryFile).mtime.toISOString(),
    });
    return true;
  }

  if (request.method === "PUT" || request.method === "POST") {
    const payload = await readJsonBody(request);
    const items = Array.isArray(payload) ? payload : payload.items;
    saveItems(items);
    sendJson(response, 200, {
      ok: true,
      count: items.length,
      updatedAt: fs.statSync(libraryFile).mtime.toISOString(),
    });
    return true;
  }

  response.writeHead(405, { Allow: "GET, PUT, POST" });
  response.end("Method not allowed");
  return true;
}

const server = http.createServer(async (request, response) => {
  try {
    if (await handleApi(request, response)) return;
    serveStatic(request, response);
  } catch (error) {
    sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
  }
});

ensureDataFile();
server.listen(port, host, () => {
  console.log(`English dictation review is running at http://${host}:${port}/`);
});
