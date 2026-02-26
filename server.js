require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

let clients = {};
let accountsInfo = {};
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = [];
let isRunning = false;

// --- Load accounts ---
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  const phone = process.env[`PHONE_${i}`];
  if (apiId && apiHash && session) {
    clients[`account${i}`] = new TelegramClient(
      new StringSession(session),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
    accountsInfo[`account${i}`] = { phone };
  }
}

// --- Connect client helper ---
async function connectClient(accountName) {
  const client = clients[accountName];
  try {
    if (!client.session.save()) await client.connect();
    return true;
  } catch (err) {
    console.log(`❌ Failed to connect ${accountName}: ${err.message}`);
    return false;
  }
}

// --- Auto join group ---
async function ensureJoined(client, group) {
  try {
    await client.getParticipants(group, { limit: 1 });
    return;
  } catch {}
  try {
    let hash = null;
    if (group.includes("t.me/")) hash = group.split("/").pop();
    if (hash) await client.invoke(new Api.messages.ImportChatInvite({ hash }));
  } catch {}
}

// --- Routes ---
app.get("/accounts", (req, res) => {
  const list = Object.keys(clients).map(name => ({ name, phone: accountsInfo[name]?.phone || "" }));
  res.json(list);
});

app.get("/stats", (req, res) => res.json(stats));
app.get("/member-logs", (req, res) => res.json(memberLogs));
app.get("/flood-waits", (req, res) => {
  const now = Date.now();
  const data = floodWaits.map(fw => ({
    ...fw,
    remainingSec: Math.max(0, Math.floor((fw.endTimeMs - now) / 1000))
  }));
  res.json(data);
});

// --- Export members ---
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;
  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });
  try {
    await connectClient(account);
    await ensureJoined(client, group);
    let participants = [];
    for await (const p of client.iterParticipants(group)) participants.push(p);
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
  if (!group) return res.json({ message: "Target group required" });
  if (isRunning) return res.json({ message: "Already running" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  memberLogs = [];

  let userIndex = 0;
  let accountIndex = 0;

  async function processNext() {
    if (!isRunning || userIndex >= usernames.length) {
      isRunning = false;
      return;
    }

    const username = usernames[userIndex];

    // Select next available account not in FLOOD_WAIT
    let attempts = 0;
    let client, accountName;
    do {
      accountName = accounts[accountIndex];
      client = clients[accountName];
      accountIndex = (accountIndex + 1) % accounts.length;
      attempts++;
    } while (floodWaits.find(fw => fw.account === accountName && Date.now() < fw.endTimeMs) && attempts <= accounts.length);

    if (!client) {
      setTimeout(processNext, 5000);
      return;
    }

    const connected = await connectClient(accountName);
    if (!connected) {
      stats.fail++;
      memberLogs.push({ username, status: "fail", error: "Cannot connect account", account: accountName });
      userIndex++;
      setTimeout(processNext, 1000);
      return;
    }

    await ensureJoined(client, group);

    // --- CHECK MEMBER EXISTENCE ---
    let exists = false;
    try {
      const participants = await client.getParticipants(group, { limit: 1000 });
      if (participants.some(p => p.username == username || p.id == username)) {
        exists = true;
      }
    } catch {}

    if (exists) {
      memberLogs.push({ username, status: "skipped", reason: "Already in group", account: accountName });
      userIndex++;
      processNext();
      return;
    }

    // --- TRY ADD MEMBER ---
    try {
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
      stats.success++;
      memberLogs.push({ username, status: "success", account: accountName });
      console.log(`✅ ${username} added by ${accountName}`);
      userIndex++;
      // Delay after success, switch account
      setTimeout(processNext, DELAY);
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("FLOOD_WAIT") || msg.includes("PEER_FLOOD")) {
        const waitSec = parseInt(msg.match(/\d+/)?.[0]) || 60;
        const endTimeMs = Date.now() + waitSec * 1000;
        floodWaits.push({ username, account: accountName, endTimeMs, remainingSec: waitSec });
        memberLogs.push({ username, status: "fail", error: msg, account: accountName });
        console.log(`⏳ ${accountName} FLOOD_WAIT ${waitSec}s`);
        userIndex++;
        setTimeout(processNext, 1000);
      } else if (msg.includes("USER_PRIVACY") || msg.includes("USER_ALREADY") || msg.includes("USER_NOT_FOUND")) {
        stats.fail++;
        memberLogs.push({ username, status: "skipped", reason: msg, account: accountName });
        console.log(`⚠ ${username} skipped (${msg})`);
        userIndex++;
        setTimeout(processNext, 1000);
      } else {
        stats.fail++;
        memberLogs.push({ username, status: "fail", error: msg, account: accountName });
        console.log(`❌ Failed ${username} - ${msg}`);
        userIndex++;
        // Delay 40s on failure
        setTimeout(processNext, 40000);
      }
    }
  }

  processNext();
  res.json({ message: `Started with ${accounts.length} accounts, delay ${DELAY / 1000}s` });
});

// --- Stop ---
app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

// --- Restart ---
app.post("/restart", (req, res) => {
  isRunning = false;
  stats = { success: 0, fail: 0 };
  memberLogs = [];
  floodWaits = [];
  res.json({ message: "Restarted" });
});

// --- Retry single user ---
app.post("/retry", async (req, res) => {
  const { username, group } = req.body;
  const availableAccounts = Object.keys(clients);
  if (!availableAccounts.length) return res.json({ error: "No accounts available" });

  const accountName = availableAccounts[Math.floor(Math.random() * availableAccounts.length)];
  const client = clients[accountName];

  const connected = await connectClient(accountName);
  if (!connected) return res.json({ error: `Cannot connect ${accountName}` });

  try {
    await ensureJoined(client, group);
    await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
    res.json({ message: `${username} retried successfully with ${accountName}` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
