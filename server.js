require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();
app.use(express.json());
app.use(cors());

// Server state
const clients = {};
let stats = {success:0, fail:0};
let memberLogs = [];
let floodWaits = [];
let isRunning = false;
let interval;

// Load accounts from .env
for(let i=1;i<=10;i++){
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  const phone = process.env[`PHONE_${i}`] || "";
  if(apiId && apiHash && session){
    const client = new TelegramClient(new StringSession(session), parseInt(apiId), apiHash, {connectionRetries:5});
    clients[`account${i}`] = {client, name:`account${i}`, phone};
  }
}

// Routes
app.get("/accounts",(req,res)=>{
  res.json(Object.values(clients).map(c=>({name:c.name, phone:c.phone})));
});

app.post("/export-members", async (req,res)=>{
  const {account, group, filterMembers, filterLastOnline, filterPhoto} = req.body;
  const accObj = Object.values(clients).find(c=>c.name===account);
  if(!accObj) return res.json({success:false,error:"Account not found"});
  const client = accObj.client;

  try{
    await client.connect();
    let participants = await client.getParticipants(group);
    
    // Filters
    if(filterMembers==="username") participants = participants.filter(p=>p.username);
    if(filterLastOnline==="week") participants = participants.filter(p=>p.status?.was_online && (Date.now()/1000 - p.status.was_online <= 7*24*3600));
    if(filterLastOnline==="month") participants = participants.filter(p=>p.status?.was_online && (Date.now()/1000 - p.status.was_online <= 30*24*3600));
    if(filterPhoto==="has") participants = participants.filter(p=>p.photo);

    const ids = participants.map(p=>p.username||p.id);
    res.json({success:true, ids});
  }catch(err){
    res.json({success:false,error:err.message});
  }
});

app.post("/start", async (req,res)=>{
  const {group, usernames, accounts} = req.body;
  if(!accounts || accounts.length===0) return res.json({message:"No accounts selected"});
  if(isRunning) return res.json({message:"Already running"});

  isRunning = true;
  stats={success:0,fail:0};
  memberLogs=[];
  let userIndex=0, accIndex=0;

  const DELAY = parseInt(process.env.DELAY_MS)||30000;

  interval = setInterval(async ()=>{
    if(!isRunning || userIndex>=usernames.length){
      clearInterval(interval); isRunning=false; return;
    }

    const accName = accounts[accIndex];
    const accObj = Object.values(clients).find(c=>c.name===accName);
    const client = accObj.client;
    const username = usernames[userIndex];

    try{
      await client.connect();
      await client.invoke(new Api.channels.InviteToChannel({channel:group, users:[username]}));
      stats.success++;
      memberLogs.push({username,status:"success"});
      userIndex++;
    }catch(err){
      if(err.message.includes("FLOOD_WAIT")){
        const waitSec = parseInt(err.message.match(/\d+/)[0]);
        floodWaits.push({username, account:accName, endTime:new Date(Date.now()+waitSec*1000).toLocaleTimeString(), remainingSec:waitSec});
        accIndex++;
        if(accIndex>=accounts.length){ clearInterval(interval); isRunning=false; }
      } else {
        stats.fail++;
        memberLogs.push({username,status:"fail",error:err.message});
        userIndex++;
      }
    }
  }, DELAY);

  res.json({message:`Started with ${accounts.length} accounts, delay ${DELAY/1000}s`});
});

app.post("/stop",(req,res)=>{
  isRunning=false;
  clearInterval(interval);
  res.json({message:"Stopped"});
});

app.post("/restart",(req,res)=>{
  isRunning=false;
  clearInterval(interval);
  stats={success:0,fail:0};
  memberLogs=[];
  floodWaits=[];
  res.json({message:"Restarted"});
});

app.get("/stats",(req,res)=>res.json(stats));
app.get("/member-logs",(req,res)=>res.json(memberLogs));
app.get("/flood-waits",(req,res)=>res.json(floodWaits));

app.listen(process.env.PORT||3000,()=>console.log("Server running"));
