"use strict";
// レンダラー: UI操作 + フレーミング/BCC/ログ。通信は preload 経由の window.serialAPI を使用。

// ===== 制御文字シンボル =====
const CTRL = {0x02:"STX",0x03:"ETX",0x04:"EOT",0x05:"ENQ",0x06:"ACK",
  0x10:"DLE",0x15:"NAK",0x0D:"CR",0x0A:"LF",0x1B:"ESC",0x00:"NUL"};

// ===== 状態 =====
let connected = false;
const rows = []; // {ts,dir,hex,asc}

// ===== DOM =====
const $ = id => document.getElementById(id);
const logEl = $("log"), counterEl = $("counter"), portSel = $("port");

// ===== API存在チェック =====
const hasAPI = (typeof window !== "undefined" && window.serialAPI);
{
  const b = $("apiBadge");
  if (hasAPI) { b.textContent = "serialport: 利用可"; b.className = "badge ok"; }
  else {
    b.textContent = "serialAPI 未ロード"; b.className = "badge ng";
    $("btnConnect").disabled = true; $("btnRefresh").disabled = true;
    logLine("err", "serialAPI が読み込まれていません（Electron外で開いた可能性）。");
  }
}

// ===== ユーティリティ =====
function nowStr(){
  const d=new Date(), p=(n,l=2)=>String(n).padStart(l,"0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`;
}
function toHex(u8){ return Array.from(u8).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join(" "); }
function toAsciiSym(u8){
  return Array.from(u8).map(b=>{
    if(CTRL[b]) return `⟨${CTRL[b]}⟩`;
    if(b>=0x20 && b<=0x7e) return String.fromCharCode(b);
    return "·";
  }).join("");
}
function parseHex(s){
  const clean=s.replace(/0x/gi,"").replace(/[^0-9a-fA-F]/g,"");
  if(clean.length===0) return [];
  if(clean.length%2!==0) throw new Error("HEXの桁数が奇数です");
  const out=[];
  for(let i=0;i<clean.length;i+=2) out.push(parseInt(clean.substr(i,2),16));
  return out;
}
function parsePayload(){
  const raw=$("payload").value;
  if($("mode").value==="hex") return parseHex(raw);
  // ASCIIモード: 半角文字を1バイト(0x00-0xFF)。日本語送信は当面HEX入力で対応。
  return Array.from(raw).map(c=>c.charCodeAt(0)&0xFF);
}
// BCC計算（暫定: STX除外・ETX含む）
function calcBCC(frame, method){
  const start=(frame[0]===0x02)?1:0;
  let v=0;
  for(let i=start;i<frame.length;i++){
    if(method==="xor") v^=frame[i]; else v=(v+frame[i])&0xFF;
  }
  return v&0xFF;
}

// ===== ログ表示 =====
function logLine(kind,text){
  const div=document.createElement("div");
  div.className="le "+kind;
  div.innerHTML=`<span class="ts">[${nowStr()}]</span> ${escapeHtml(text)}`;
  logEl.appendChild(div); afterAppend();
}
function logFrame(dir,u8){
  const ts=nowStr(), hex=toHex(u8), asc=toAsciiSym(u8);
  rows.push({ts,dir,hex,asc});
  const div=document.createElement("div");
  div.className="le "+dir.toLowerCase();
  const ascHtml = $("showAscii").checked ? ` <span class="asc">| ${escapeHtml(asc)}</span>` : "";
  div.innerHTML=`<span class="ts">[${ts}]</span><span class="dir">${dir}</span>${escapeHtml(hex)}${ascHtml}`;
  logEl.appendChild(div); afterAppend();
}
function afterAppend(){
  counterEl.textContent=`${logEl.childElementCount} 件`;
  if($("autoscroll").checked) logEl.scrollTop=logEl.scrollHeight;
}
function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

// ===== ポート列挙 =====
async function refreshPorts(){
  if(!hasAPI) return;
  try{
    const ports = await window.serialAPI.list();
    const prev = portSel.value;
    portSel.innerHTML="";
    if(ports.length===0){
      const o=document.createElement("option"); o.value=""; o.textContent="(ポートが見つかりません)";
      portSel.appendChild(o);
    }
    for(const p of ports){
      const o=document.createElement("option");
      o.value=p.path;
      const label = p.friendlyName || p.manufacturer;
      o.textContent = label ? `${p.path} — ${label}` : p.path;
      portSel.appendChild(o);
    }
    if(prev) portSel.value = prev;
    logLine("info", `ポート一覧を更新（${ports.length}件）`);
  }catch(e){ logLine("err","ポート列挙に失敗: "+e.message); }
}

// ===== 接続 / 切断 =====
async function connect(){
  if(!hasAPI) return;
  const path = portSel.value;
  if(!path){ logLine("err","ポートを選択してください"); return; }
  const opt={
    path,
    baudRate:parseInt($("baud").value,10),
    dataBits:parseInt($("data").value,10),
    stopBits:parseInt($("stop").value,10),
    parity:$("parity").value,
    flowControl:$("flow").value
  };
  try{
    await window.serialAPI.open(opt);
    setConnected(true);
    logLine("info",`接続しました: ${path}（${opt.baudRate},${opt.parity},${opt.dataBits},${opt.stopBits} / flow:${opt.flowControl}）`);
  }catch(e){
    logLine("err","接続に失敗: "+e.message);
  }
}
async function disconnect(){
  if(!hasAPI) return;
  try{ await window.serialAPI.close(); }catch(e){ logLine("err","切断エラー: "+e.message); }
  setConnected(false);
  logLine("info","切断しました。");
}
function setConnected(on){
  connected=on;
  $("dot").className="dot"+(on?" on":"");
  $("statusText").textContent=on?"接続中":"未接続";
  $("btnConnect").disabled=on || !hasAPI;
  $("btnDisconnect").disabled=!on;
  $("btnSend").disabled=!on;
  $("port").disabled=on; $("btnRefresh").disabled=on || !hasAPI;
  document.querySelectorAll("[data-byte]").forEach(b=>b.disabled=!on);
}

// ===== 送信 =====
async function sendBytes(bytes){
  if(!connected){ logLine("err","未接続です"); return; }
  try{
    await window.serialAPI.write(bytes);
    logFrame("TX", Uint8Array.from(bytes));
  }catch(e){ logLine("err","送信エラー: "+e.message); }
}
function buildAndSend(){
  let payload;
  try{ payload=parsePayload(); }
  catch(e){ logLine("err","入力エラー: "+e.message); return; }
  const frame=[];
  if($("addSTX").checked) frame.push(0x02);
  for(const b of payload) frame.push(b);
  if($("addETX").checked) frame.push(0x03);
  if($("addBCC").checked){
    let bcc=calcBCC(frame,$("bccMethod").value);
    if($("errBCC").checked){ bcc=(bcc+1)&0xFF; logLine("warn","BCC誤り注入: 正規値に+1して送信します"); }
    frame.push(bcc);
  }
  sendBytes(frame);
}

// ===== 受信イベント（preload経由）=====
if(hasAPI){
  window.serialAPI.onData(arr => logFrame("RX", Uint8Array.from(arr)));
  window.serialAPI.onError(msg => logLine("err","受信エラー: "+msg));
  window.serialAPI.onClosed(() => { if(connected){ setConnected(false); logLine("info","ポートが閉じられました。"); } });
}

// ===== UIイベント =====
$("btnRefresh").onclick=refreshPorts;
$("btnConnect").onclick=connect;
$("btnDisconnect").onclick=disconnect;
$("btnSend").onclick=buildAndSend;
$("payload").addEventListener("keydown",e=>{ if(e.key==="Enter" && !$("btnSend").disabled) buildAndSend(); });
document.querySelectorAll("[data-byte]").forEach(b=>{
  b.onclick=()=>sendBytes([parseInt(b.dataset.byte,10)]);
});
document.querySelectorAll(".pill").forEach(p=>{
  p.onclick=()=>{
    const [baud,par,data,stop]=p.dataset.set.split(",");
    $("baud").value=baud; $("parity").value=par; $("data").value=data; $("stop").value=stop;
  };
});
$("btnClear").onclick=()=>{ logEl.innerHTML=""; rows.length=0; counterEl.textContent="0 件"; };
$("btnSave").onclick=()=>{
  if(rows.length===0){ logLine("info","保存するログがありません"); return; }
  const text=rows.map(r=>`[${r.ts}] ${r.dir}\t${r.hex}\t| ${r.asc}`).join("\r\n");
  const blob=new Blob([text],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`commlog_${new Date().toISOString().replace(/[:.]/g,"-")}.txt`;
  a.click(); URL.revokeObjectURL(a.href);
};

// ===== 起動処理 =====
if(hasAPI){
  refreshPorts();
  logLine("info","準備完了。ポートを選択し「接続」を押してください。");
}
