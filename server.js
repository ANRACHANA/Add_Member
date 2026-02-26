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
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

let clients = {};
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = []; // {username, account, endTimeMs, remainingSec}
let isRunning = false;

// Load accounts
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  const phone = process.env[`PHONE_${i}`] || "";
  if (apiId && apiHash && session) {
    const client = new TelegramClient(new StringSession(session), parseInt(apiId), apiHash, { connectionRetries: 5 });
    clients[`account${i}`] = { client, phone };
  }
}

// Utility: ensure joined
async function ensureJoined(client, group){
  try{
    await client.getParticipants(group, { limit:1 });
    return;
  } catch{
    if(group.includes("t.me/")){
      const hash = group.split("/").pop();
      if(hash) await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    }
  }
}

// Routes
app.get("/accounts",(req,res)=>{
  const list = Object.keys(clients).map(name=>({
    name,
    phone: clients[name].phone
  }));
  res.json(list);
});

app.get("/stats",(req,res)=>res.json(stats));
app.get("/member-logs",(req,res)=>res.json(memberLogs));
app.get("/flood-waits",(req,res)=>res.json(floodWaits));

app.post("/export-members", async (req,res)=>{
  const { account, group } = req.body;
  const acc = clients[account];
  if(!acc) return res.json({success:false,error:"Account not found"});
  try{
    await acc.client.connect();
    await ensureJoined(acc.client, group);
    let participants = [];
    for await (const p of acc.client.iterParticipants(group)) participants.push(p);
    const ids = participants.map(p=>p.username||p.id);
    res.json({success:true,ids});
  }catch(err){
    res.json({success:false,error:err.message});
  }
});

app.post("/start", async (req,res)=>{
  const { group, usernames, accounts } = req.body;
  if(!accounts || accounts.length===0) return res.json({message:"No accounts selected"});
  if(isRunning) return res.json({message:"Already running"});

  isRunning = true;
  stats={success:0,fail:0};
  memberLogs=[];
  floodWaits=[];
  let userIndex=0;
  let accIndex=0;

  const processNext = async ()=>{
    if(!isRunning || userIndex >= usernames.length){
      isRunning=false;
      return;
    }

    const username = usernames[userIndex];
    let attempts=0;
    let clientObj;
    // Skip accounts in FLOOD_WAIT
    do{
      const accName = accounts[accIndex];
      clientObj = clients[accName];
      accIndex=(accIndex+1)%accounts.length;
      attempts++;
      if(attempts>accounts.length){
        // all accounts in flood wait, wait 5s then retry
        setTimeout(processNext,5000);
        return;
      }
    }while(floodWaits.find(f=>f.account===Object.keys(clients)[accIndex] && Date.now()<f.endTimeMs));

    try{
      await ensureJoined(clientObj.client, group);
      await clientObj.client.invoke(new Api.channels.InviteToChannel({ channel: group, users:[username] }));
      stats.success++;
      memberLogs.push({username,status:"success",account:Object.keys(clients)[accIndex]});
      userIndex++;
      setTimeout(processNext, DELAY);
    }catch(err){
      if(err.message.includes("FLOOD_WAIT")){
        const sec = parseInt(err.message.match(/\d+/)[0]);
        const endTimeMs = Date.now()+sec*1000;
        floodWaits.push({username,account:Object.keys(clients)[accIndex],endTimeMs,remainingSec:sec});
        memberLogs.push({username,status:"fail",error:err.message,account:Object.keys(clients)[accIndex]});
        userIndex++;
        processNext();
      } else {
        stats.fail++;
        memberLogs.push({username,status:"fail",error:err.message,account:Object.keys(clients)[accIndex]});
        userIndex++;
        processNext();
      }
    }
  };

  processNext();
  res.json({message:`Started with ${accounts.length} accounts, delay ${DELAY/1000}s`});
});

app.post("/stop",(req,res)=>{isRunning=false;res.json({message:"Stopped"});});
app.post("/restart",(req,res)=>{
  isRunning=false;
  stats={success:0,fail:0};
  memberLogs=[];
  floodWaits=[];
  res.json({message:"Restarted"});
});

app.post("/retry", async (req,res)=>{
  const { username, group } = req.body;
  const accNames = Object.keys(clients);
  const accName = accNames[Math.floor(Math.random()*accNames.length)];
  const clientObj = clients[accName];
  try{
    await ensureJoined(clientObj.client, group);
    await clientObj.client.invoke(new Api.channels.InviteToChannel({ channel: group, users:[username] }));
    res.json({message:`${username} retried successfully with ${accName}`});
  }catch(err){
    res.json({error:err.message});
  }
});

app.listen(PORT,()=>console.log(`Server running at http://localhost:${PORT}`));
