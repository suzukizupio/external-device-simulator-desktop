"use strict";
// 非接触キー画面ロジック。電文生成は protocol/noncontact-key.js、通信は preload の window.serialAPI。

const T = window.NoncontactKey;
const $ = id => document.getElementById(id);
let connected = false;
let pendingResponse = null;
const hasAPI = !!window.serialAPI;

function nowStr(){ const d=new Date(),p=(n,l=2)=>String(n).padStart(l,"0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`; }
function esc(s){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function log(kind,text){ const el=$("log"); const d=document.createElement("div"); d.className="le "+kind; d.innerHTML=`<span class="ts">[${nowStr()}]</span> ${esc(text)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function logFrame(dir,arr){ const el=$("log"),ts=nowStr(),hex=T.toHex(arr); const d=document.createElement("div"); d.className="le "+dir.toLowerCase(); d.innerHTML=`<span class="ts">[${ts}]</span><span class="dir">${dir}</span>${esc(hex)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }

async function refreshPorts(){
  if(!hasAPI) return;
  try{
    const ports=await window.serialAPI.list(); const sel=$("port"),prev=sel.value; sel.innerHTML="";
    if(ports.length===0){ const o=document.createElement("option"); o.value=""; o.textContent="(ポートなし)"; sel.appendChild(o); }
    for(const p of ports){ const o=document.createElement("option"); o.value=p.path; const lb=p.friendlyName||p.manufacturer; o.textContent=lb?`${p.path} — ${lb}`:p.path; sel.appendChild(o); }
    if(prev) sel.value=prev;
    log("info",`ポート一覧更新（${ports.length}件）`);
  }catch(e){ log("err","ポート列挙失敗: "+e.message); }
}
async function connect(){
  if(!hasAPI) return;
  const path=$("port").value; if(!path){ log("err","ポートを選択してください"); return; }
  const baudRate=parseInt($("baud").value)||9600;
  try{
    await window.serialAPI.open({path,baudRate,dataBits:8,stopBits:1,parity:"even",flowControl:"none"});
    setConnected(true);
    log("info",`接続: ${path}（${baudRate},E,8,1）`);
  }catch(e){ log("err","接続失敗: "+e.message); }
}
async function disconnect(){
  if(pendingResponse){ pendingResponse.resolve("closed"); pendingResponse=null; }
  if(!hasAPI) return;
  try{ await window.serialAPI.close(); }catch(e){}
  setConnected(false);
  log("info","切断しました");
}
function setConnected(on){
  connected=on;
  $("dot").className="dot"+(on?" on":"");
  $("statusText").textContent=on?`接続中 (${$("baud").value},E,8,1)`:"未接続";
  $("btnConnect").disabled=on||!hasAPI;
  $("btnDisconnect").disabled=!on;
  $("btnSend").disabled=!on;
  $("port").disabled=on;
  $("baud").disabled=on;
  $("btnRefresh").disabled=on||!hasAPI;
}

function formatOptions(def){
  return Object.keys(T.FORMAT_LABEL).map(k=>`<option value="${k}" ${k===def?"selected":""}>${T.FORMAT_LABEL[k]}</option>`).join("");
}
function roomString(buildingNo, roomNo){
  return String(parseInt(buildingNo)||0).slice(-1) + String(parseInt(roomNo)||0).padStart(4,"0").slice(-4);
}
function buildTable(){
  const count=Math.max(1,Math.min(100,parseInt($("count").value)||5));
  const gate=parseInt($("gate").value)||1;
  const building=parseInt($("building").value)||0;
  const startRoom=parseInt($("startRoom").value)||101;
  const startPerson=parseInt($("startPerson").value)||1;
  const format=$("defaultFormat").value;
  const tb=$("tbody"); tb.innerHTML="";
  for(let i=1;i<=count;i++){
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td style="text-align:center"><input type="checkbox" class="cb-send"></td>
      <td style="text-align:center;color:#4fc1ff;font-weight:bold">${i}</td>
      <td><input type="text" class="in-gate" value="${gate}"></td>
      <td><input type="text" class="in-room5" value="${roomString(building,startRoom+i-1)}"></td>
      <td><input type="text" class="in-person" value="${String(startPerson+i-1).padStart(3,"0").slice(-3)}"></td>
      <td><select class="in-format">${formatOptions(format)}</select></td>`;
    tb.appendChild(tr);
  }
  log("info",`キー読取データ ${count} 件を生成しました`);
}
function collectSelected(){
  const rows=[];
  document.querySelectorAll("#tbody tr").forEach(tr=>{
    if(tr.querySelector(".cb-send").checked){
      rows.push({
        gateNo:parseInt(tr.querySelector(".in-gate").value)||1,
        roomNo5:tr.querySelector(".in-room5").value,
        personNo:parseInt(tr.querySelector(".in-person").value)||0,
        format:tr.querySelector(".in-format").value,
      });
    }
  });
  return rows;
}

function buildPackets(){
  const rows=collectSelected();
  if(rows.length===0){ log("err","「送信」にチェックしたキー読取データがありません"); return null; }
  const bad=$("bccMode").value==="bad";
  return rows.map(row=>{
    const packet=T.buildTelegram(row);
    return bad ? T.corruptBCC(packet) : packet;
  });
}
function generate(){
  const rows=collectSelected();
  if(rows.length===0){ log("err","「送信」にチェックしたキー読取データがありません"); return null; }
  const bad=$("bccMode").value==="bad";
  const packets=rows.map(row=>{
    const packet=T.buildTelegram(row);
    return bad ? T.corruptBCC(packet) : packet;
  });
  const pv=$("preview"); pv.innerHTML="";
  packets.forEach((packet,idx)=>{
    const row=rows[idx];
    const d=document.createElement("div"); d.className="pkt";
    const ok=T.verifyBCC(packet) ? "BCC OK" : "BCC NG";
    d.innerHTML=`<div class="pkt-h">${T.FORMAT_LABEL[row.format]}・ゲート${row.gateNo}・ルーム${row.roomNo5}・個人${String(row.personNo).padStart(3,"0")}・${packet.length}バイト・${ok}</div><div class="pkt-hex">${T.toHex(packet)}</div><div class="pkt-asc">${esc(T.bytesToAscii(packet))}</div>`;
    pv.appendChild(d);
  });
  log("info",`電文生成: ${packets.length}件（${bad ? "BCC誤り注入" : "BCC正常"}）`);
  return packets;
}

function waitForAckNak(timeoutMs){
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{ pendingResponse=null; resolve("timeout"); }, timeoutMs);
    pendingResponse={
      resolve:(value)=>{ clearTimeout(timer); pendingResponse=null; resolve(value); }
    };
  });
}
async function sendPacketWithRetry(packet, index, total){
  const waitResponse=$("waitResponse").value==="yes";
  const timeoutMs=Math.max(100,parseInt($("ackTimeout").value)||5000);
  const retryCount=Math.max(0,Math.min(20,parseInt($("retryCount").value)||5));
  const maxAttempts=waitResponse ? retryCount + 1 : 1;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      await window.serialAPI.write(packet);
      logFrame("TX",packet);
      log("info",`送信 ${index}/${total} 試行${attempt}/${maxAttempts}`);
    }catch(e){ log("err","送信エラー: "+e.message); return false; }
    if(!waitResponse) return true;

    const result=await waitForAckNak(timeoutMs);
    if(result==="ack"){ log("info",`ACK受信: ${index}/${total}`); return true; }
    if(result==="nak"){ log("warn",`NAK受信: ${attempt < maxAttempts ? "再送します" : "再送上限に達しました"}`); continue; }
    if(result==="closed"){ log("err","応答待ち中にポートが閉じられました"); return false; }
    log("warn",`ACK待ちタイムアウト: ${attempt < maxAttempts ? "再送します" : "再送上限に達しました"}`);
  }
  return false;
}
async function send(){
  const packets=generate();
  if(!packets) return;
  if(!connected){ log("err","未接続のためプレビューのみ"); return; }
  for(let i=0;i<packets.length;i++){
    const ok=await sendPacketWithRetry(packets[i], i+1, packets.length);
    if(!ok) break;
  }
}

if(hasAPI){
  window.serialAPI.onData(arr=>{
    logFrame("RX",arr);
    if(pendingResponse){
      if(arr.includes(T.CODE.ACK)) pendingResponse.resolve("ack");
      else if(arr.includes(T.CODE.NAK)) pendingResponse.resolve("nak");
    }
  });
  window.serialAPI.onError(msg=>log("err","受信エラー: "+msg));
  window.serialAPI.onClosed(()=>{
    if(pendingResponse){ pendingResponse.resolve("closed"); pendingResponse=null; }
    if(connected){ setConnected(false); log("info","ポートが閉じられました"); }
  });
}

$("btnRefresh").onclick=refreshPorts;
$("btnConnect").onclick=connect;
$("btnDisconnect").onclick=disconnect;
$("btnBuild").onclick=buildTable;
$("btnGenerate").onclick=generate;
$("btnSend").onclick=send;
$("btnCheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=true);
$("btnUncheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=false);
$("btnClear").onclick=()=>{ $("log").innerHTML=""; };

if(!hasAPI) log("err","serialAPI 未ロード（Electron外で開いた可能性）");
else refreshPorts();
buildTable();
log("info","非接触キー画面。キー読取データを設定→電文生成→接続後に送信できます。");
