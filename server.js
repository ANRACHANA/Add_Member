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

// Serve HTML
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

// --- Multi-account setup ---
let clients = {};
let accountsInfo = {};
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

// Connect all clients at startup
(async () => {
  for (const name in clients) {
    try {
      await clients[name].connect();
      console.log(`✅ Connected ${name}`);
    } catch (err) {
      console.log(`❌ Failed to connect ${name}: ${err.message}`);
    }
  }
})();

// --- In-memory stats ---
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = []; // {username, account, endTime, remainingSec}
let isRunning = false;
let interval;

// --- Helper: Auto join group if not joined ---
async function ensureJoined(client, group) {
  try {
    await client.getParticipants(group, { limit: 1 });
    return; // already joined
  } catch {}

  try {
    let hash = null;
    if (group.includes("t.me/")) {
      const parts = group.split("/");
      hash = parts[parts.length - 1];
    }

    if (hash) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      console.log(`✅ Auto-joined group ${group}`);
    } else {
      console.log(`⚠️ Cannot auto-join group: ${group}, use exact invite link`);
    }
  } catch (err) {
    console.log(`❌ Failed to auto-join ${group}: ${err.message}`);
  }
}

// --- Routes ---
app.get("/accounts", (req, res) => {
  const list = Object.keys(clients).map((name) => ({
    name,
    phone: accountsInfo[name]?.phone || "",
  }));
  res.json(list);
});

app.get("/stats", (req, res) => res.json(stats));
app.get("/member-logs", (req, res) => res.json(memberLogs));
app.get("/flood-waits", (req, res) => res.json(floodWaits));

// --- Export members ---
app.post("/export-members", async (req, res) => {
  const { account, group, filterMembers, filterLastOnline, filterPhoto } = req.body;
  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });

  try {
    await ensureJoined(client, group);

    let participants = [];
    for await (const user of client.iterParticipants(group)) {
      participants.push(user);
    }

    // Filters
    if (filterMembers === "username") participants = participants.filter((p) => p.username);
    if (filterPhoto === "has") participants = participants.filter((p) => p.photo);
    if (filterLastOnline !== "all") {
      const now = Date.now();
      participants = participants.filter((p) => {
        if (!p.status || !p.status.date) return false;
        const statusDate = new Date(p.status.date * 1000);
        if (filterLastOnline === "week") return now - statusDate <= 7 * 24 * 3600 * 1000;
        if (filterLastOnline === "month") return now - statusDate <= 30 * 24 * 3600 * 1000;
        return true;
      });
    }

    const ids = participants.map((p) => p.username || p.id);
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

    await ensureJoined(client, group);

    try {
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
      stats.success++;
      memberLogs.push({ username, status: "success", account: accountName });
      console.log(`✅ ${username} added by ${accountName}`);

      userIndex++;
      accountIndex = (accountIndex + 1) % accounts.length; // switch account
    } catch (err) {
      if (err.message.includes("FLOOD_WAIT")) {
        const waitSec = parseInt(err.message.match(/\d+/)[0]);
        floodWaits.push({
          username,
          account: accountName,
          endTime: new Date(Date.now() + waitSec * 1000).toLocaleTimeString(),
          remainingSec: waitSec,
        });
        accountIndex = (accountIndex + 1) % accounts.length;
      } else if (
        err.message.includes("USER_PRIVACY") ||
        err.message.includes("USER_ALREADY") ||
        err.message.includes("USER_BANNED")
      ) {
        stats.fail++;
        memberLogs.push({ username, status: "skipped", reason: err.message, account: accountName });
        userIndex++;
        accountIndex = (accountIndex + 1) % accounts.length;
      } else {
        stats.fail++;
        memberLogs.push({ username, status: "fail", error: err.message, account: accountName });
        userIndex++;
        accountIndex = (accountIndex + 1) % accounts.length;
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

// --- Retry single user ---
app.post("/retry", async (req, res) => {
  const { username, group } = req.body;
  if (!group) return res.json({ error: "Target group required" });

  const availableAccounts = Object.keys(clients);
  if (availableAccounts.length === 0) return res.json({ error: "No accounts available" });

  const accountName = availableAccounts[Math.floor(Math.random() * availableAccounts.length)];
  const client = clients[accountName];

  try {
    await ensureJoined(client, group);
    await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
    res.json({ message: `${username} retried successfully with ${accountName}` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
