require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const DELAY_SUCCESS = 5000; // delay after successful add
const DELAY_FAIL = 40000;   // delay after fail (FLOOD_WAIT, etc.)

// --- Multi-account setup ---
let clients = {};
let accountsInfo = {};
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  const phone = process.env[`PHONE_${i}`];
  if (apiId && apiHash && session) {
    const client = new TelegramClient(new StringSession(session), parseInt(apiId), apiHash, { connectionRetries: 5 });
    clients[`account${i}`] = client;
    accountsInfo[`account${i}`] = { phone };
  }
}

// --- In-memory data ---
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = [];
let isRunning = false;

// --- Helper: auto join ---
async function ensureJoined(client, group) {
  try { await client.getParticipants(group, { limit: 1 }); return; } catch {}
  try {
    let hash = null;
    if (group.includes("t.me/")) hash = group.split("/").pop();
    if (hash) await client.invoke(new Api.messages.ImportChatInvite({ hash }));
  } catch {}
}

// --- Routes ---
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/accounts",(req,res)=>{
  const list = Object.keys(clients).map(name => ({ name, phone: accountsInfo[name]?.phone||"" }));
  res.json(list);
});
app.get("/stats",(req,res)=>res.json(stats));
app.get("/member-logs",(req,res)=>res.json(memberLogs));
app.get("/flood-waits",(req,res)=>res.json(floodWaits));

// --- Export members with photo ---
app.post("/export-members", async (req,res)=>{
  const { account, group } = req.body;
  const client = clients[account];
  if(!client) return res.json({success:false,error:"Account not found"});
  try {
    await client.connect();
    await ensureJoined(client, group);

    let participants = [];
    for await (const user of client.iterParticipants(group)) participants.push(user);

    const ids = await Promise.all(participants.map(async p=>{
      let photoUrl = null;
      if(p.photo){
        try{
          const buffer = await client.downloadProfilePhoto(p,{ downloadBig: false });
          photoUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
        }catch{}
      }
      return { id:p.id, username:p.username, firstName:p.firstName||"", lastName:p.lastName||"", photo:photoUrl };
    }));

    res.json({ success:true, ids });
  } catch(err){
    res.json({ success:false, error: err.message });
  }
});

// --- Start adding members ---
app.post("/start", async (req,res)=>{
  const { group, usernames, accounts } = req.body;
  if(!accounts || accounts.length===0) return res.json({message:"No accounts selected"});
  if(!usernames || usernames.length===0) return res.json({message:"No usernames"});
  if(isRunning) return res.json({message:"Already running"});

  isRunning = true;
  stats = { success:0, fail:0 };
  memberLogs = [];
  floodWaits = [];

  let userIndex = 0;
  let accountIndex = 0;

  const processNext = async ()=>{
    if(!isRunning || userIndex >= usernames.length){
      isRunning = false; return;
    }

    const username = usernames[userIndex];

    // skip accounts in FLOOD_WAIT
    let client, accName, attempts=0;
    do{
      accName = accounts[accountIndex];
      client = clients[accName];
      accountIndex = (accountIndex+1)%accounts.length;
      attempts++;
      if(attempts>accounts.length){
        // all accounts in FLOOD_WAIT, wait 10s
        setTimeout(processNext,10000); return;
      }
    }while(floodWaits.find(f=>f.account===accName && Date.now()<f.endTimeMs));

    await client.connect();
    await ensureJoined(client, group);

    try{
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users:[username] }));
      stats.success++;
      memberLogs.push({ username, status:"success", account:accName });
      console.log(`✅ ${username} added by ${accName}`);
      userIndex++;
      setTimeout(processNext, DELAY_SUCCESS);
    }catch(err){
      if(err.message.includes("FLOOD_WAIT")){
        const waitSec = parseInt(err.message.match(/\d+/)[0]);
        const endTimeMs = Date.now()+waitSec*1000;
        floodWaits.push({ username, account:accName, endTime: new Date(endTimeMs).toLocaleString(), endTimeMs, remainingSec:waitSec });
        memberLogs.push({ username, status:"fail", error:err.message, account:accName });
        console.log(`⚠ FLOOD_WAIT ${username} on ${accName}`);
        userIndex++;
        setTimeout(processNext, DELAY_FAIL);
      } else if(err.message.includes("USER_PRIVACY") || err.message.includes("USER_ALREADY") || err.message.includes("USER_BANNED")){
        memberLogs.push({ username, status:"skipped", reason:err.message, account:accName });
        userIndex++;
        processNext();
      } else {
        stats.fail++;
        memberLogs.push({ username, status:"fail", error:err.message, account:accName });
        userIndex++;
        setTimeout(processNext, DELAY_FAIL);
      }
    }
  };

  processNext();
  res.json({ message:`Started with ${accounts.length} accounts` });
});

app.post("/stop",(req,res)=>{ isRunning=false; res.json({message:"Stopped"}); });
app.post("/restart",(req,res)=>{ isRunning=false; stats={success:0,fail:0}; memberLogs=[]; floodWaits=[]; res.json({message:"Restarted"}); });

// --- Start server ---
app.listen(PORT,()=>console.log(`Server running at http://localhost:${PORT}`));
