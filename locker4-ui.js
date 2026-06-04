"use strict";
// 宅配4線式(B方式) 画面ロジック。電文生成は protocol/locker4.js (window.Telegram4)、通信は preload の window.serialAPI。

const T = window.Telegram4;
const $ = id => document.getElementById(id);
let connected = false;
const logRows = [];
const hasAPI = !!window.serialAPI;

// ===== ログ =====
function nowStr(){ const d=new Date(),p=(n,l=2)=>String(n).padStart(l,"0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`; }
function esc(s){ return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function log(kind,text){ const el=$("log"); const d=document.createElement("div"); d.className="le "+kind; d.innerHTML=`<span class="ts">[${nowStr()}]</span> ${esc(text)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }
function logFrame(dir,arr){ const el=$("log"),ts=nowStr(),hex=T.toHex(arr); logRows.push({ts,dir,hex}); const d=document.createElement("div"); d.className="le "+dir.toLowerCase(); d.innerHTML=`<span class="ts">[${ts}]</span><span class="dir">${dir}</span>${esc(hex)}`; el.appendChild(d); el.scrollTop=el.scrollHeight; }

// ===== 接続 (宅配4線式は 4800,E,8,1 固定) =====
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
async function disconnect(){ if(!hasAPI) return; try{ await window.serialAPI.close(); }catch(e){} setConnected(false); log("info","切断しました"); }
function setConnected(on){ connected=on; $("dot").className="dot"+(on?" on":""); $("statusText").textContent=on?"接続中 (4800,E,8,1)":"未接続"; $("btnConnect").disabled=on||!hasAPI; $("btnDisconnect").disabled=!on; $("btnSend").disabled=!on; $("port").disabled=on; $("btnRefresh").disabled=on||!hasAPI; }

// ===== ロッカーテーブル =====
function stateOptions(def){
  return Object.keys(T.STATE_LABEL).map(k=>{ const c=parseInt(k); return `<option value="${c}" ${c===def?"selected":""}>${T.STATE_LABEL[c]} (0x${c.toString(16).toUpperCase()})</option>`; }).join("");
}
function buildTable(){
  const count=Math.max(1,Math.min(100,parseInt($("count").value)||10));
  const startRoom=parseInt($("startRoom").value)||0;
  const building=parseInt($("building").value)||0;
  const tb=$("tbody"); tb.innerHTML="";
  for(let i=1;i<=count;i++){
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td style="text-align:center"><input type="checkbox" class="cb-send"></td>
      <td style="text-align:center;color:#4fc1ff;font-weight:bold">${i}</td>
      <td><input type="text" class="in-locker" value="${i}"></td>
      <td><input type="text" class="in-building" value="${building}"></td>
      <td><input type="text" class="in-room" value="${startRoom? (startRoom+i-1):""}"></td>
      <td><select class="in-state">${stateOptions(T.STATE.EMPTY)}</select></td>`;
    tb.appendChild(tr);
  }
  log("info",`ロッカー ${count} 件を生成しました`);
}
function collectSelected(){
  const rows=[];
  document.querySelectorAll("#tbody tr").forEach(tr=>{
    if(tr.querySelector(".cb-send").checked){
      rows.push({
        state:parseInt(tr.querySelector(".in-state").value),
        lockerNo:parseInt(tr.querySelector(".in-locker").value)||0,
        buildingNo:parseInt(tr.querySelector(".in-building").value)||0,
        roomNo:parseInt(tr.querySelector(".in-room").value)||0,
      });
    }
  });
  return rows;
}

// ===== 電文生成（パケット分割対応） =====
function generate(){
  const rows=collectSelected();
  if(rows.length===0){ log("err","「送信」にチェックしたロッカーがありません"); return null; }
  const pktSize=parseInt($("pktSize").value);
  const modelNo=parseInt($("modelNo").value)||1;
  const numPackets=Math.ceil(rows.length/pktSize);
  const telegrams=[];
  for(let i=0;i<numPackets;i++){
    const slice=rows.slice(i*pktSize,(i+1)*pktSize);
    const packageNo=numPackets-1-i; // 残り後続パケット数（最後=00）
    telegrams.push(T.buildTextTelegram({packageNo,modelNo,lockers:slice}));
  }
  const pv=$("preview"); pv.innerHTML="";
  telegrams.forEach((tg,idx)=>{
    const cnt=Math.min(pktSize,rows.length-idx*pktSize);
    const d=document.createElement("div"); d.className="pkt";
    d.innerHTML=`<div class="pkt-h">パケット ${idx+1}/${numPackets}　残り後続=${numPackets-1-idx}　${cnt}ロッカー　${tg.length}バイト</div><div class="pkt-hex">${T.toHex(tg)}</div>`;
    pv.appendChild(d);
  });
  log("info",`電文生成: ${rows.length}ロッカー → ${numPackets}パケット（1パケット最大${pktSize}）`);
  return telegrams;
}
async function send(){
  const telegrams=generate();
  if(!telegrams) return;
  if(!connected){ log("err","未接続のためプレビューのみ（接続すると送信できます）"); return; }
  for(const tg of telegrams){
    try{ await window.serialAPI.write(tg); logFrame("TX",tg); }
    catch(e){ log("err","送信エラー: "+e.message); break; }
  }
  log("warn","テキスト電文を送信しました（※ENQ/ACK/EOTのコンテンション方式は次段階で実装）");
}

// ===== 受信 =====
if(hasAPI){
  window.serialAPI.onData(arr=>logFrame("RX",arr));
  window.serialAPI.onError(msg=>log("err","受信エラー: "+msg));
  window.serialAPI.onClosed(()=>{ if(connected){ setConnected(false); log("info","ポートが閉じられました"); } });
}

// ===== イベント =====
$("btnRefresh").onclick=refreshPorts;
$("btnConnect").onclick=connect;
$("btnDisconnect").onclick=disconnect;
$("btnBuild").onclick=buildTable;
$("btnGenerate").onclick=generate;
$("btnSend").onclick=send;
$("btnCheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=true);
$("btnUncheckAll").onclick=()=>document.querySelectorAll(".cb-send").forEach(c=>c.checked=false);
$("btnClear").onclick=()=>{ $("log").innerHTML=""; logRows.length=0; };

// ===== 起動 =====
if(!hasAPI) log("err","serialAPI 未ロード（Electron外で開いた可能性）");
else refreshPorts();
buildTable();
log("info","宅配4線式(B方式)画面。状態を設定→「電文生成」で確認、接続後に「送信」できます。");
