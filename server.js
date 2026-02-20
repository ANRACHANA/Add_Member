require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(express.json());
app.use(cors());

// Serve HTML directly
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

// --- Multi-account setup ---
let clients = {};
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  if (apiId && apiHash && session) {
    clients[`account${i}`] = new TelegramClient(
      new StringSession(session),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
  }
}

// --- In-memory stats ---
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = []; // {username, account, endTime, remainingSec}
let isRunning = false;
let interval;

// --- Routes ---
app.get("/accounts", (req, res) => res.json(Object.keys(clients)));
app.get("/stats", (req, res) => res.json(stats));
app.get("/member-logs", (req, res) => res.json(memberLogs));
app.get("/flood-waits", (req, res) => res.json(floodWaits));

// --- Export members ---
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;
  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });

  try {
    await client.connect();
    const participants = await client.getParticipants(group);
    const ids = participants.map(p => p.username || p.id);
    res.json({ success: true, ids });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// --- Start adding members ---
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;
  if (!accounts || accounts.length === 0) return res.json({ message: "No accounts selected" });
  if (isRunning) return res.json({ message: "Already running" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  memberLogs = [];
  floodWaits = [];
  let userIndex = 0;
  let accountIndex = 0;

  interval = setInterval(async () => {
    if (!isRunning || userIndex >= usernames.length) {
      clearInterval(interval);
      isRunning = false;
      return;
    }

    const accountName = accounts[accountIndex];
    const client = clients[accountName];
    const username = usernames[userIndex];

    try {
      await client.connect();
      await client.invoke(new Api.channels.InviteToChannel({
        channel: group,
        users: [username]
      }));
      console.log(`✅ ${accountName} added ${username}`);
      stats.success++;
      memberLogs.push({ username, status: "success" });
      userIndex++;

    } catch (err) {
      if (err.message.includes("FLOOD_WAIT")) {
        console.log(`⚠ FLOOD_WAIT on ${accountName}`);
        const waitSec = parseInt(err.message.match(/\d+/)[0]);
        floodWaits.push({
          username,
          account: accountName,
          endTime: new Date(Date.now() + waitSec * 1000).toLocaleTimeString(),
          remainingSec: waitSec
        });
        accountIndex++;
        if (accountIndex >= accounts.length) {
          clearInterval(interval);
          isRunning = false;
        }
      } else {
        console.log(`❌ Failed ${username} - ${err.message}`);
        stats.fail++;
        memberLogs.push({ username, status: "fail", error: err.message });
        userIndex++;
      }
    }
  }, DELAY);

  res.json({ message: `Started with ${accounts.length} accounts, delay ${DELAY / 1000}s` });
});

// --- Stop ---
app.post("/stop", (req, res) => {
  isRunning = false;
  clearInterval(interval);
  res.json({ message: "Stopped" });
});

// --- Restart ---
app.post("/restart", (req, res) => {
  isRunning = false;
  clearInterval(interval);
  stats = { success: 0, fail: 0 };
  memberLogs = [];
  floodWaits = [];
  res.json({ message: "Restarted" });
});

// --- Retry single user (optional) ---
app.post("/retry", async (req, res) => {
  const { username, group } = req.body;
  const availableAccounts = Object.keys(clients);
  if (availableAccounts.length === 0) return res.json({ error: "No accounts available" });

  const accountName = availableAccounts[0];
  const client = clients[accountName];

  try {
    await client.connect();
    await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
    res.json({ message: `${username} retried successfully with ${accountName}` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
