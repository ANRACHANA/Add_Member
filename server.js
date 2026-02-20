require("dotenv").config();
const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ==============================
   In-Memory State (Render safe)
============================== */

let queue = [];
let processing = false;
let stopped = false;
let stats = { success: 0, fail: 0 };
let logs = [];
let floodWaits = []; // { id, endTime }

/* ==============================
   Utility Functions
============================== */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addLog(status, id, error = null) {
  logs.push({ status, id, error });
  if (logs.length > 500) logs.shift();
}

function formatDate(date) {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

/* ==============================
   Queue Processor
============================== */

async function processQueue() {
  if (processing || stopped) return;
  processing = true;

  while (queue.length > 0 && !stopped) {
    const job = queue.shift();

    try {
      await handleJob(job);
      stats.success++;
      addLog("success", job.id);
    } catch (err) {
      stats.fail++;
      addLog("fail", job.id, err.message);

      if (err.retryAfter) {
        const endTime = new Date(Date.now() + err.retryAfter * 1000);
        floodWaits.push({
          id: job.id,
          endTime,
        });

        setTimeout(() => {
          queue.push(job);
          floodWaits = floodWaits.filter(f => f.id !== job.id);
          processQueue();
        }, err.retryAfter * 1000);
      }
    }

    await sleep(2000); // delay between jobs
  }

  processing = false;
}

/* ==============================
   Fake Job Handler (Example)
============================== */

async function handleJob(job) {
  // Simulate random failure
  const random = Math.random();

  if (random < 0.2) {
    const error = new Error("Simulated Flood Wait");
    error.retryAfter = 10; // seconds
    throw error;
  }

  await sleep(1000);
}

/* ==============================
   API Routes
============================== */

app.post("/start", async (req, res) => {
  const { items } = req.body;
  if (!items || items.length === 0) {
    return res.json({ error: "No items provided" });
  }

  stopped = false;
  items.forEach(id => queue.push({ id }));
  processQueue();

  res.json({ message: "Queue started" });
});

app.post("/stop", (req, res) => {
  stopped = true;
  res.json({ message: "Stopped" });
});

app.post("/restart", (req, res) => {
  stopped = false;
  processQueue();
  res.json({ message: "Restarted" });
});

app.get("/stats", (req, res) => {
  res.json(stats);
});

app.get("/logs", (req, res) => {
  res.json(logs);
});

app.get("/flood-waits", (req, res) => {
  const data = floodWaits.map(f => ({
    id: f.id,
    endTime: formatDate(f.endTime),
    remainingSec: Math.max(
      0,
      Math.floor((f.endTime - Date.now()) / 1000)
    ),
  }));
  res.json(data);
});

/* ==============================
   Auto Resume After Crash
============================== */

setInterval(() => {
  if (!processing && queue.length > 0 && !stopped) {
    processQueue();
  }
}, 5000);

/* ==============================
   Start Server
============================== */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});