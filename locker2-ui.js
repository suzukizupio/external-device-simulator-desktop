"use strict";
// 宅配2線式 画面ロジック。電文生成は protocol/locker2.js (window.Telegram2)、通信は preload の window.serialAPI。

const T = window.Telegram2;
const $ = id => document.getElementById(id);
let connected = false;
let repeatTimer = null, repeatRows = [], repeatIdx = 0;
const hasAPI = !!window.serialAPI;

// ===== ログ =====
function nowStr(){ const d=new Date(),p=(n,l=2)=>String(n).padStart(l,"0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`; }
function esc(s){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function log(kind,text){ const el=$("log"); const d=document.createElement("div"); d.className="le "+kind; d.innerHTML=`<span class="ts">[${nowStr()}]</span> ${esc(text)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function logFrame(dir,arr){ const el=$("log"),ts=nowStr(),hex=T.toHex(arr); const d=document.createElement("div"); d.className="le "+dir.toLowerCase(); d.innerHTML=`<span class="ts">[${ts}]</span><span class="dir">${dir}</span>${esc(hex)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }

// ===== 接続 (4800,E,8,1 固定) =====
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
  try{ await window.serialAPI.open({path,baudRate:4800,dataBits:8,stopBits:1,parity:"even",flowControl:"none"}); setConnected(true); log("info",`接続: ${path}（4800,E,8,1）`); }
  catch(e){ log("err","接続失敗: "+e.message); }
}
async function disconnect(){ stopRepeat(); if(!hasAPI) return; try{ await window.serialAPI.close(); }catch(e){} setConnected(false); log("info","切断しました"); }
function setConnected(on){
  connected=on;
  $("dot").className="dot"+(on?" on":"");
  $("statusText").textContent=on?"接続中 (4800,E,8,1)":"未接続";
  $("btnConnect").disabled=on||!hasAPI; $("btnDisconnect").disabled=!on;
  $("btnSendOnce").disabled=!on; $("port").disabled=on; $("btnRefresh").disabled=on||!hasAPI;
  setRepeating(!!repeatTimer);
}
function setRepeating(on){ $("btnGo").disabled=on||!connected; $("btnStop").disabled=!on; }

// ===== ロッカーテーブル =====
function stateOptions(def){
  return Object.keys(T.CMD_LABEL).map(k=>{ const c=parseInt(k); return `<option value="${c}" ${c===def?"selected":""}>${T.CMD_LABEL[c]} (0x${c.toString(16).toUpperCase()})</option>`; }).join("");
}
function buildTable(){
  const count=Math.max(1,Math.min(100,parseInt($("count").value)||9));
  const building=parseInt($("building").value)||0;
  const startRoom=parseInt($("startRoom").value)||101;
  const startAddr=parseInt($("startAddr").value)||1;
  const tb=$("tbody"); tb.innerHTML="";
  for(let i=1;i<=count;i++){
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td style="text-align:center"><input type="checkbox" class="cb-send"></td>
      <td style="text-align:center;color:#4fc1ff;font-weight:bold">${i}</td>
      <td><input type="text" class="in-room" value="${startRoom+i-1}"></td>
      <td><input type="text" class="in-building" value="${building}"></td>
      <td><input type="text" class="in-addr" value="${startAddr+i-1}"></td>
      <td><select class="in-state">${stateOptions(T.CMD.ARRIVE)}</select></td>`;
    tb.appendChild(tr);
  }
  log("info",`住戸 ${count} 件を生成しました`);
}
function collectSelected(){
  const rows=[];
  document.querySelectorAll("#tbody tr").forEach(tr=>{
    if(tr.querySelector(".cb-send").checked){
      rows.push({
        command:parseInt(tr.querySelector(".in-state").value),
        roomNo:parseInt(tr.querySelector(".in-room").value)||0,
        buildingNo:parseInt(tr.querySelector(".in-building").value)||0,
        address:parseInt(tr.querySelector(".in-addr").value)||0,
      });
    }
  });
  return rows;
}

// ===== 電文生成（プレビュー） =====
function generate(){
  const rows=collectSelected();
  if(rows.length===0){ log("err","「送信」にチェックした住戸がありません"); return null; }
  const pv=$("preview"); pv.innerHTML="";
  const telegrams=rows.map(lk=>T.buildTelegram(lk));
  rows.forEach((lk,idx)=>{
    const d=document.createElement("div"); d.className="pkt";
    d.innerHTML=`<div class="pkt-h">${T.CMD_LABEL[lk.command]}・住戸${lk.roomNo}・棟${lk.buildingNo||"なし"}・アドレス${lk.address}</div><div class="pkt-hex">${T.toHex(telegrams[idx])}</div>`;
    pv.appendChild(d);
  });
  log("info",`電文生成: ${rows.length}住戸（各11バイト）`);
  return telegrams;
}

// ===== 送信 =====
async function sendOnce(){
  const telegrams=generate();
  if(!telegrams) return;
  if(!connected){ log("err","未接続のためプレビューのみ"); return; }
  for(const tg of telegrams){
    try{ await window.serialAPI.write(tg); logFrame("TX",tg); }
    catch(e){ log("err","送信エラー: "+e.message); break; }
  }
  log("info",`${telegrams.length}住戸を送信（1巡）`);
}
// 繰り返し送信（仕様: 5住戸/秒）= 200msごとに1住戸
function startRepeat(){
  if(repeatTimer){ return; }
  const rows=collectSelected();
  if(rows.length===0){ log("err","送信対象（送信チェック）がありません"); return; }
  if(!connected){ log("err","未接続です"); return; }
  repeatRows=rows; repeatIdx=0; generate();
  repeatTimer=setInterval(sendNext,200);
  setRepeating(true);
  log("info",`繰り返し送信を開始（${rows.length}住戸・5住戸/秒）`);
}
async function sendNext(){
  if(repeatRows.length===0) return;
  const lk=repeatRows[repeatIdx % repeatRows.length]; repeatIdx++;
  const tg=T.buildTelegram(lk);
  try{ await window.serialAPI.write(tg); logFrame("TX",tg); }
  catch(e){ log("err","送信エラー: "+e.message); stopRepeat(); }
}
function stopRepeat(){
  if(repeatTimer){ clearInterval(repeatTimer); repeatTimer=null; setRepeating(false); log("info","繰り返し送信を停止しました"); }
}

// ===== 受信（2線式は単方向だが、念のため受信もログ） =====
if(hasAPI){
  window.serialAPI.onData(arr=>logFrame("RX",arr));
  window.serialAPI.onError(msg=>log("err","受信エラー: "+msg));
  window.serialAPI.onClosed(()=>{ if(connected){ stopRepeat(); setConnected(false); log("info","ポートが閉じられました"); } });
}

// ===== イベント =====
$("btnRefresh").onclick=refreshPorts;
$("btnConnect").onclick=connect;
$("btnDisconnect").onclick=disconnect;
$("btnBuild").onclick=buildTable;
$("btnGenerate").onclick=generate;
$("btnSendOnce").onclick=sendOnce;
$("btnGo").onclick=startRepeat;
$("btnStop").onclick=stopRepeat;
$("btnCheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=true);
$("btnUncheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=false);
$("btnClear").onclick=()=>{ $("log").innerHTML=""; };

// ===== 起動 =====
if(!hasAPI) log("err","serialAPI 未ロード（Electron外で開いた可能性）");
else refreshPorts();
buildTable();
setRepeating(false);
log("info","宅配2線式画面。状態を設定→「電文生成」で確認、接続後「単発送信」または「GO」で繰り返し送信できます。");
