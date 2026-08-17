const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Global error handlers — prevent process crash on unhandled rejections ---
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason?.message || reason);
});

function logMem(label) {
  const m = process.memoryUsage();
  console.log(`[mem:${label}] rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB`);
}

const SERVICE_KEY = process.env.FFMPEG_SERVICE_KEY_V2 || process.env.FFMPEG_SERVICE_KEY;

// --- Auth middleware -------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization;
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// --- R2 client (S3-compatible) --------------------------------------------
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// In-memory job store. Render instances are long-lived on the paid tier.
// If the instance restarts mid-render, the Base44 poller will eventually
// time out and the user can re-trigger — same failure mode as Shotstack.
const jobs = new Map();

// --- Helpers ---------------------------------------------------------------

async function downloadFile(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": "LoopcastRenderService/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function fmtAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Builds an ASS subtitle file from caption chunks, matching the 4 caption
// styles that were previously rendered by Shotstack's HTML overlay engine.
function buildAss(captions, styleName) {
  // ASS colour format: &HAABBGGRR  (AA=alpha 00=opaque, then BGR)
  const styles = {
    bold_white:      { font: "Arial Black",      size: 76, primary: "&H00FFFFFF", outline: "&H00000000", bold: -1, outlineW: 4, shadow: 0 },
    karaoke_yellow:  { font: "Arial Black",      size: 68, primary: "&H0000EBFF", outline: "&H00000000", bold: -1, outlineW: 4, shadow: 0 },
    minimal_clean:   { font: "Helvetica Neue",   size: 60, primary: "&H00FFFFFF", outline: "&H80000000", bold: 0,  outlineW: 1, shadow: 2 },
    neon_glow:       { font: "Arial Black",      size: 68, primary: "&H00FFFFFF", outline: "&H00FF00FF", bold: -1, outlineW: 3, shadow: 2 },
  };
  const s = styles[styleName] || styles.bold_white;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.font},${s.size},${s.primary},${s.outline},&H80000000,${s.bold},0,0,0,100,100,0,0,1,${s.outlineW},${s.shadow},2,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = captions
    .map((c) => {
      const text = String(c.text).replace(/\n/g, "\\N");
      return `Dialogue: 0,${fmtAssTime(c.start)},${fmtAssTime(c.start + c.length)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error("ffmpeg stderr:", (stderr || "").slice(-500));
        reject(new Error((stderr || "").slice(-500) || err.message));
      } else {
        resolve();
      }
    });
  });
}

// --- Render pipeline -------------------------------------------------------

async function processRender(jobId, payload) {
  const { segments, audio_url, targetSeconds, captions, captionStyle, clipDuration = 8, assetType = "video", music_url = null, music_volume = 0.15 } = payload;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));

  try {
    logMem("render-start");
    // 1. Download all segments
    const segFiles = [];
    for (let i = 0; i < segments.length; i++) {
      const ext = assetType === "image" ? ".jpg" : ".mp4";
      const f = path.join(workDir, `seg${i}${ext}`);
      console.log(`[${jobId}] downloading segment ${i + 1}/${segments.length}`);
      await downloadFile(segments[i], f);
      segFiles.push(f);
    }
    logMem("after-downloads");

    // 2. Download narration audio
    let audioFile = null;
    if (audio_url) {
      audioFile = path.join(workDir, "audio.mp3");
      await downloadFile(audio_url, audioFile);
    }

    // 2b. Download background music
    let musicFile = null;
    if (music_url) {
      try {
        musicFile = path.join(workDir, "music.mp3");
        await downloadFile(music_url, musicFile);
      } catch (e) {
        console.error(`[${jobId}] music download failed:`, e.message);
        musicFile = null;
      }
    }

    // 3. Build ASS caption file
    let assFile = null;
    if (captions && captions.length > 0) {
      assFile = path.join(workDir, "captions.ass");
      fs.writeFileSync(assFile, buildAss(captions, captionStyle));
    }

    // 4. Build FFmpeg command
    const target = Math.max(targetSeconds || 75, 10);
    const numSegs = segFiles.length;
    const args = [];

    // Segment inputs — images get -loop 1 -t {clipDuration}, videos are plain -i
    for (let i = 0; i < numSegs; i++) {
      if (assetType === "image") {
        args.push("-loop", "1", "-t", String(clipDuration), "-i", segFiles[i]);
      } else {
        args.push("-i", segFiles[i]);
      }
    }
    // Audio input (narration)
    if (audioFile) {
      args.push("-i", audioFile);
    }
    // Music input
    if (musicFile) {
      args.push("-i", musicFile);
    }

    // filter_complex: normalize each segment → concat → burn subtitles
    let filter = "";
    for (let i = 0; i < numSegs; i++) {
      filter += `[${i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30`;
      if (assetType !== "image") {
        filter += `,trim=duration=${clipDuration},setpts=PTS-STARTPTS`;
      }
      filter += `[v${i}];`;
    }
    for (let i = 0; i < numSegs; i++) {
      filter += `[v${i}]`;
    }
    filter += `concat=n=${numSegs}:v=1:a=0[vcat];`;

    if (assFile) {
      // Escape backslashes and colons in the path for the subtitles filter
      const escPath = assFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
      filter += `[vcat]subtitles='${escPath}'[vout]`;
    } else {
      filter += `[vcat]null[vout]`;
    }

    // Audio mixing: combine narration and background music at lower volume
    const audioIdx = numSegs;
    const musicIdx = numSegs + (audioFile ? 1 : 0);
    if (audioFile && musicFile) {
      filter += `;[${audioIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo[narration_a];[${musicIdx}:a]volume=${music_volume},aformat=sample_rates=44100:channel_layouts=stereo[music_low];[narration_a][music_low]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    } else if (musicFile) {
      filter += `;[${musicIdx}:a]volume=${music_volume},aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
    }

    args.push("-filter_complex", filter, "-map", "[vout]");

    if (audioFile && musicFile) {
      args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k");
    } else if (audioFile) {
      args.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "128k");
    } else if (musicFile) {
      args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k");
    }

    args.push(
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-r", "30", "-pix_fmt", "yuv420p",
      "-t", String(target),
      "-movflags", "+faststart",
      "-y",
      path.join(workDir, "output.mp4")
    );

    console.log(`[${jobId}] ffmpeg start: ${numSegs} ${assetType} segments, target ${target}s`);
    logMem("before-ffmpeg");
    await runFFmpeg(args);
    logMem("after-ffmpeg");
    console.log(`[${jobId}] ffmpeg done, uploading to R2`);

    // 5. Upload to R2
    const key = `renders/${jobId}.mp4`;
    const fileBuf = fs.readFileSync(path.join(workDir, "output.mp4"));
    console.log(`[${jobId}] output size: ${Math.round(fileBuf.length / 1024)}KB`);
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: fileBuf,
        ContentType: "video/mp4",
      })
    );

    const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    jobs.set(jobId, { status: "done", url: publicUrl });
    logMem("render-done");
    console.log(`[${jobId}] complete: ${publicUrl}`);
  } catch (e) {
    console.error(`[${jobId}] failed:`, e.message, e.stack);
    jobs.set(jobId, { status: "failed", error: e.message });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

// --- Routes ----------------------------------------------------------------

app.post("/render", (req, res) => {
  const { segments } = req.body;
  if (!segments || segments.length === 0) {
    return res.status(400).json({ error: "no segments" });
  }
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "pending" });
  processRender(jobId, req.body).catch((e) => {
    console.error(`[${jobId}] processRender unhandled:`, e.message);
    jobs.set(jobId, { status: "failed", error: e.message });
  });
  res.json({ id: jobId });
});

app.get("/render/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "failed" });
  res.json({ status: job.status, url: job.url || null, error: job.error || null });
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Diagnostics endpoint (auth required) — checks FFmpeg + R2 config
app.get("/diagnostics", async (req, res) => {
  const diag = {
    ffmpeg: false,
    r2_configured: false,
    r2_vars: {},
    env_vars: {},
  };

  // Check FFmpeg
  try {
    await new Promise((resolve, reject) => {
      execFile("ffmpeg", ["-version"], (err, stdout) => {
        if (err) {
          diag.ffmpeg_error = err.message;
          reject(err);
        } else {
          diag.ffmpeg = true;
          diag.ffmpeg_version = stdout.slice(0, 100);
          resolve();
        }
      });
    });
  } catch (e) {
    diag.ffmpeg = false;
    diag.ffmpeg_error = e.message;
  }

  // Check R2 env vars (show presence, not values)
  const r2Vars = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
  for (const v of r2Vars) {
    diag.r2_vars[v] = !!process.env[v];
  }
  diag.r2_configured = r2Vars.every((v) => !!process.env[v]);

  // Check other env vars
  diag.env_vars.FFMPEG_SERVICE_KEY = !!process.env.FFMPEG_SERVICE_KEY;
  diag.env_vars.PORT = process.env.PORT || "3000";

  res.json(diag);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render service listening on :${PORT}`));